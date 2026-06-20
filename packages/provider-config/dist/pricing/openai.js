"use strict";
/**
 * OpenAI pricing view — thin derivation over the canonical registry.
 *
 * Public API preserved exactly for back-compat with v1.x callers
 * (provider-runtime's openai-api provider, plugin settings UI).
 *
 * gpt-5.5 long-context multiplier (prompts > 272K input tokens are
 * priced at 2× input / 1.5× output for the full session) is NOT modeled
 * here — see registry.js banner. Flat rate applies for typical <272K
 * prompts.
 *
 * The `cached_input` field is tracked **separately** for telemetry but
 * the v1.2 cost calculator bills cached tokens at the full input rate.
 * Per the design-spec open-question decision, we hold the discount in
 * reserve until OpenAI's public pricing for prompt-cache hits is stable
 * across SKUs. Once formalized, switch the cost calculator to apply the
 * cached_input rate without changing the table shape.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const registry = require("../registry");
// Guard against NaN / Infinity token counts (see anthropic.js for rationale).
function _finite(n) {
    return (typeof n === "number" && Number.isFinite(n)) ? n : 0;
}
// Derive MODEL_PRICES object keyed by model id (back-compat shape).
// Includes `_default` fallback for unknown model ids.
const MODEL_PRICES = (() => {
    const out = {};
    for (const m of registry.modelsByVendor("openai"))
        out[m.id] = m.pricing;
    out._default = registry.VENDOR_FALLBACK_PRICING.openai;
    return out;
})();
// Derive cross-vendor + native-passthrough alias map.
// Cross-vendor: haiku/sonnet/opus/opus[1m] → concrete OpenAI ids.
// Native passthrough: concrete id → itself (so resolveModel is a no-op
// for callers already holding a concrete id).
const MODEL_ALIAS = (() => {
    const out = {};
    for (const [alias, perVendor] of Object.entries(registry.CROSS_VENDOR_ALIASES)) {
        const pv = perVendor;
        if (pv.openai)
            out[alias] = pv.openai;
    }
    for (const m of registry.modelsByVendor("openai")) {
        if (out[m.id] && out[m.id] !== m.id) {
            throw new Error(`pricing/openai.js: alias collision — concrete id "${m.id}" would overwrite ` +
                `cross-vendor mapping "${m.id}" → "${out[m.id]}". Rename either the model ` +
                `id or the cross-vendor alias in registry.js.`);
        }
        out[m.id] = m.id;
    }
    return out;
})();
const DEFAULT_MODEL = registry.defaultModelFor("openai");
/**
 * Resolve an alias or concrete model id to a concrete model id for this vendor.
 *
 * - Falsy input (null, undefined, "") → DEFAULT_MODEL.
 * - Known cross-vendor alias (haiku/sonnet/opus/opus[1m]) → vendor-specific concrete id.
 * - Known concrete id (native passthrough) → returned unchanged.
 * - Unknown id → returned unchanged (callers may layer `coerceToVendorModel`
 *   on top for vendor-strict resolution; this function is permissive).
 *
 * @param {string|null|undefined} alias
 * @returns {string} concrete model id
 */
function resolveModel(alias) {
    if (!alias)
        return DEFAULT_MODEL;
    return MODEL_ALIAS[alias] || alias;
}
/**
 * Provider-strict resolver — mirrors `resolveModel` but rejects cross-vendor
 * leakage. Used by the OpenAIProvider constructor so a stale
 * `settings.model = "gemini-2.5-flash"` (carried over from prior Gemini use)
 * does NOT reach OpenAI's API verbatim and 400. Forward-compat preserved
 * for ids in OpenAI's namespace (`gpt-`, `o3`, `o4`) so brand-new model
 * names work without a code update.
 *
 * Issue #27.
 */
function coerceToVendorModel(alias) {
    const resolved = resolveModel(alias);
    if (MODEL_PRICES[resolved])
        return resolved;
    if (typeof resolved === "string" && /^(gpt-|o3|o4)/i.test(resolved))
        return resolved;
    return DEFAULT_MODEL;
}
// CODEX_CLI_SUPPORTED_MODELS — derived from registry's codexCliSupported flag.
// See registry.js for empirical verdict + rationale.
const CODEX_CLI_SUPPORTED_MODELS = registry.codexCliSupportedModels();
function priceFor(modelId) {
    return MODEL_PRICES[modelId] || MODEL_PRICES._default;
}
/**
 * Compute USD cost for a single completion given OpenAI's token-usage block.
 *
 * Expected `usage` shape (from chat.completions response):
 *   {
 *     prompt_tokens: number,
 *     completion_tokens: number,
 *     prompt_tokens_details?: { cached_tokens?: number },
 *   }
 *
 * Cached tokens are billed at full input rate per the v1.2 design decision.
 * `cachedTokens` is returned in the breakdown for UI/telemetry transparency.
 *
 * @returns {{ cost: number, breakdown: { input: number, output: number, cachedTokens: number } }}
 */
function computeCost(usage, modelId) {
    if (!usage)
        return { cost: 0, breakdown: { input: 0, output: 0, cachedTokens: 0 } };
    const p = priceFor(modelId);
    const inputTokens = _finite(usage.prompt_tokens);
    const outputTokens = _finite(usage.completion_tokens);
    const ptd = usage.prompt_tokens_details;
    const cachedTokens = _finite(ptd && ptd.cached_tokens);
    const inputCost = (inputTokens / 1_000_000) * p.input; // cached billed at full rate (v1.2 decision)
    const outputCost = (outputTokens / 1_000_000) * p.output;
    return {
        cost: inputCost + outputCost,
        breakdown: { input: inputCost, output: outputCost, cachedTokens },
    };
}
/**
 * Returns the dropdown-ordered list of models for the panel header. Mirror
 * shape the chat-view consumes from anthropic-api: `[{ id, label }]`.
 */
function getModelDropdownOptions() {
    return registry.dropdownFor("openai").map((o) => ({
        id: o.id,
        label: o.desc ? `${o.label} · ${o.desc}` : o.label,
    }));
}
/**
 * Codex-CLI-specific dropdown — filters the OpenAI list to only models
 * confirmed to work with Codex CLI's ChatGPT-account auth path. See the
 * `CODEX_CLI_SUPPORTED_MODELS` block above for the empirically-tested
 * supported set and the rationale.
 */
function getCodexCliModelDropdownOptions() {
    return getModelDropdownOptions().filter((opt) => CODEX_CLI_SUPPORTED_MODELS.has(opt.id));
}
const CODEX_CLI_DEFAULT_MODEL = "gpt-5.4-mini";
/**
 * Codex-CLI-specific resolver — like `coerceToVendorModel` but further
 * restricts to the ChatGPT-account-supported subset. Cross-vendor stale
 * ids (`sonnet`, `gemini-2.5-flash`), API-only ids (`gpt-5-mini`,
 * `gpt-4o`), and unknowns all fall through to `gpt-5.4-mini` rather
 * than reaching codex's spawn arg and getting a 400 at request time.
 */
function coerceToCodexCliModel(alias) {
    const resolved = coerceToVendorModel(alias);
    if (CODEX_CLI_SUPPORTED_MODELS.has(resolved))
        return resolved;
    return CODEX_CLI_DEFAULT_MODEL;
}
module.exports = {
    MODEL_PRICES,
    MODEL_ALIAS,
    DEFAULT_MODEL,
    resolveModel,
    coerceToVendorModel,
    priceFor,
    computeCost,
    getModelDropdownOptions,
    // Codex-CLI-specific surface (ChatGPT-account auth path)
    CODEX_CLI_SUPPORTED_MODELS,
    CODEX_CLI_DEFAULT_MODEL,
    getCodexCliModelDropdownOptions,
    coerceToCodexCliModel,
};
