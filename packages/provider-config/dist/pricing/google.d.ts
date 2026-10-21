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
 * leakage. Used by the GoogleProvider constructor so that a stale
 * `settings.model = "gpt-4o-mini"` (carried over from prior OpenAI use) does
 * NOT reach Gemini's API verbatim and 400. Forward-compat preserved for ids
 * that look like Gemini ids (gemini- prefix) — those pass through even if not
 * yet in MODEL_PRICES, so a brand-new model name works without a code update.
 *
 * Issue #27.
 */
declare function coerceToVendorModel(alias: string | null | undefined): string;
declare function priceFor(modelId: string): ModelPricing;
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
declare function computeCost(usage: Record<string, unknown> | null | undefined, modelId: string): {
    cost: number;
    breakdown: {
        input: number;
        output: number;
        cachedTokens: number;
    };
};
declare function getModelDropdownOptions(): {
    id: string;
    label: string;
}[];
declare const ANTIGRAVITY_CLI_SUPPORTED_MODELS: Set<string>;
declare const ANTIGRAVITY_CLI_DEFAULT_MODEL: string;
declare function getAntigravityCliModelDropdownOptions(): {
    id: string;
    label: string;
}[];
/**
 * antigravity-cli resolver. A REGISTRY id agy is known to reject coerces to
 * the agy default; an id outside the registry passes through untouched,
 * because agy has its own vocabulary (`gemini-3.8-flash-low`, `auto`) that
 * Gryphon only partly knows.
 */
declare function coerceToAntigravityCliModel(alias: string | null | undefined): string;
export { ANTIGRAVITY_CLI_SUPPORTED_MODELS, ANTIGRAVITY_CLI_DEFAULT_MODEL, getAntigravityCliModelDropdownOptions, coerceToAntigravityCliModel, MODEL_PRICES, MODEL_ALIAS, DEFAULT_MODEL, resolveModel, coerceToVendorModel, priceFor, computeCost, getModelDropdownOptions, };
