"use strict";
/**
 * Google/Gemini pricing view — thin derivation over the canonical registry.
 *
 * Public API preserved exactly for back-compat with v1.x callers
 * (provider-runtime's google-api / gemini-cli providers, plugin settings UI).
 *
 * Some Gemini models tier pricing by prompt length (≤200K vs >200K input
 * tokens). For v1.2 we model the ≤200K rate — the typical Obsidian case.
 * The >200K multiplier is tracked as a follow-up.
 *
 * Modality-specific pricing (audio inputs cost more on Flash-tier models)
 * is approximated at the text/image/video rate.
 *
 * The `cached_input` field is tracked separately for telemetry but the
 * v1.2 cost calculator bills cached tokens at the full input rate per
 * the design-spec decision (consistent with anthropic-api + openai-api).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MODEL = exports.MODEL_ALIAS = exports.MODEL_PRICES = exports.ANTIGRAVITY_CLI_DEFAULT_MODEL = exports.ANTIGRAVITY_CLI_SUPPORTED_MODELS = void 0;
exports.getAntigravityCliModelDropdownOptions = getAntigravityCliModelDropdownOptions;
exports.coerceToAntigravityCliModel = coerceToAntigravityCliModel;
exports.resolveModel = resolveModel;
exports.coerceToVendorModel = coerceToVendorModel;
exports.priceFor = priceFor;
exports.computeCost = computeCost;
exports.getModelDropdownOptions = getModelDropdownOptions;
const registry = __importStar(require("../registry"));
// Guard against NaN / Infinity token counts (see anthropic.js for rationale).
function _finite(n) {
    return (typeof n === "number" && Number.isFinite(n)) ? n : 0;
}
// Derive MODEL_PRICES object keyed by model id (back-compat shape).
// Includes `_default` fallback for unknown model ids.
const MODEL_PRICES = (() => {
    const out = {};
    for (const m of registry.modelsByVendor("google"))
        out[m.id] = m.pricing;
    out._default = registry.VENDOR_FALLBACK_PRICING.google;
    return out;
})();
exports.MODEL_PRICES = MODEL_PRICES;
// Derive cross-vendor + native-passthrough alias map.
// Cross-vendor: haiku/sonnet/opus/opus[1m] → concrete Google ids.
// Native passthrough: concrete id → itself (so resolveModel is a no-op
// for callers already holding a concrete id).
const MODEL_ALIAS = (() => {
    const out = {};
    for (const [alias, perVendor] of Object.entries(registry.CROSS_VENDOR_ALIASES)) {
        const pv = perVendor;
        if (pv.google)
            out[alias] = pv.google;
    }
    for (const m of registry.modelsByVendor("google")) {
        if (out[m.id] && out[m.id] !== m.id) {
            throw new Error(`pricing/google.js: alias collision — concrete id "${m.id}" would overwrite ` +
                `cross-vendor mapping "${m.id}" → "${out[m.id]}". Rename either the model ` +
                `id or the cross-vendor alias in registry.js.`);
        }
        out[m.id] = m.id;
    }
    return out;
})();
exports.MODEL_ALIAS = MODEL_ALIAS;
const DEFAULT_MODEL = registry.defaultModelFor("google");
exports.DEFAULT_MODEL = DEFAULT_MODEL;
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
 * leakage. Used by the GoogleProvider constructor so that a stale
 * `settings.model = "gpt-4o-mini"` (carried over from prior OpenAI use) does
 * NOT reach Gemini's API verbatim and 400. Forward-compat preserved for ids
 * that look like Gemini ids (gemini- prefix) — those pass through even if not
 * yet in MODEL_PRICES, so a brand-new model name works without a code update.
 *
 * Issue #27.
 */
function coerceToVendorModel(alias) {
    const resolved = resolveModel(alias);
    if (MODEL_PRICES[resolved])
        return resolved;
    // Forward-compat: ids that look like Gemini's namespace pass through.
    if (typeof resolved === "string" && /^gemini-/i.test(resolved))
        return resolved;
    // Cross-vendor leak — fall back to this vendor's default.
    return DEFAULT_MODEL;
}
function priceFor(modelId) {
    return MODEL_PRICES[modelId] || MODEL_PRICES._default;
}
/**
 * Compute USD cost for a single completion given Gemini's usage block.
 *
 * Expected `usage` shape (from GenerateContentResponse.usageMetadata):
 *   {
 *     promptTokenCount: number,
 *     candidatesTokenCount: number,
 *     cachedContentTokenCount?: number,
 *   }
 *
 * Cached tokens are billed at full input rate per v1.2 design decision.
 *
 * @returns {{ cost: number, breakdown: { input: number, output: number, cachedTokens: number } }}
 */
function computeCost(usage, modelId) {
    if (!usage)
        return { cost: 0, breakdown: { input: 0, output: 0, cachedTokens: 0 } };
    const p = priceFor(modelId);
    const inputTokens = _finite(usage.promptTokenCount);
    const outputTokens = _finite(usage.candidatesTokenCount);
    const cachedTokens = _finite(usage.cachedContentTokenCount);
    const inputCost = (inputTokens / 1_000_000) * p.input; // cached billed at full rate (v1.2 decision)
    const outputCost = (outputTokens / 1_000_000) * p.output;
    return {
        cost: inputCost + outputCost,
        breakdown: { input: inputCost, output: outputCost, cachedTokens },
    };
}
function getModelDropdownOptions() {
    return registry.dropdownFor("google").map((o) => ({
        id: o.id,
        label: o.desc ? `${o.label} · ${o.desc}` : o.label,
    }));
}
// ANTIGRAVITY_CLI_SUPPORTED_MODELS — ids agy's own catalog accepts (registry
// `antigravityCliSupported`). The antigravity-cli provider reuses this
// vendor's dropdown; this is its filter, mirroring Codex's in pricing/openai.
const ANTIGRAVITY_CLI_SUPPORTED_MODELS = registry.antigravityCliSupportedModels();
exports.ANTIGRAVITY_CLI_SUPPORTED_MODELS = ANTIGRAVITY_CLI_SUPPORTED_MODELS;
const ANTIGRAVITY_CLI_DEFAULT_MODEL = DEFAULT_MODEL;
exports.ANTIGRAVITY_CLI_DEFAULT_MODEL = ANTIGRAVITY_CLI_DEFAULT_MODEL;
function getAntigravityCliModelDropdownOptions() {
    return getModelDropdownOptions().filter((opt) => ANTIGRAVITY_CLI_SUPPORTED_MODELS.has(opt.id));
}
/**
 * antigravity-cli resolver. A REGISTRY id agy is known to reject coerces to
 * the agy default; an id outside the registry passes through untouched,
 * because agy has its own vocabulary (`gemini-3.8-flash-low`, `auto`) that
 * Gryphon only partly knows.
 */
function coerceToAntigravityCliModel(alias) {
    const resolved = coerceToVendorModel(alias);
    if (ANTIGRAVITY_CLI_SUPPORTED_MODELS.has(resolved))
        return resolved;
    if (registry.isKnownModel(resolved))
        return ANTIGRAVITY_CLI_DEFAULT_MODEL;
    return resolved;
}
