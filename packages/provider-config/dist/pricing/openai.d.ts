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
interface ModelPricing {
    input: number;
    output: number;
    cached_input?: number;
    [rate: string]: number | undefined;
}
declare const MODEL_PRICES: Record<string, ModelPricing>;
declare const MODEL_ALIAS: Record<string, string>;
declare const DEFAULT_MODEL: string;
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
declare function resolveModel(alias: string | null | undefined): string;
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
declare function coerceToVendorModel(alias: string | null | undefined): string;
declare const CODEX_CLI_SUPPORTED_MODELS: Set<string>;
declare function priceFor(modelId: string): ModelPricing;
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
declare function computeCost(usage: Record<string, unknown> | null | undefined, modelId: string): {
    cost: number;
    breakdown: {
        input: number;
        output: number;
        cachedTokens: number;
    };
};
/**
 * Returns the dropdown-ordered list of models for the panel header. Mirror
 * shape the chat-view consumes from anthropic-api: `[{ id, label }]`.
 */
declare function getModelDropdownOptions(): {
    id: string;
    label: string;
}[];
/**
 * Codex-CLI-specific dropdown — filters the OpenAI list to only models
 * confirmed to work with Codex CLI's ChatGPT-account auth path. See the
 * `CODEX_CLI_SUPPORTED_MODELS` block above for the empirically-tested
 * supported set and the rationale.
 */
declare function getCodexCliModelDropdownOptions(): {
    id: string;
    label: string;
}[];
declare const CODEX_CLI_DEFAULT_MODEL = "gpt-5.6-terra";
/**
 * Codex-CLI-specific resolver — like `coerceToVendorModel` but further
 * restricts to the ChatGPT-account-supported subset. Cross-vendor stale
 * ids (`sonnet`, `gemini-2.5-flash`), API-only ids (`gpt-5-mini`,
 * `gpt-4o`), and unknowns all fall through to `gpt-5.6-terra` rather
 * than reaching codex's spawn arg and getting a 400 at request time.
 */
declare function coerceToCodexCliModel(alias: string | null | undefined): string;
export { MODEL_PRICES, MODEL_ALIAS, DEFAULT_MODEL, resolveModel, coerceToVendorModel, priceFor, computeCost, getModelDropdownOptions, CODEX_CLI_SUPPORTED_MODELS, CODEX_CLI_DEFAULT_MODEL, getCodexCliModelDropdownOptions, coerceToCodexCliModel, };
