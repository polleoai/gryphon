/**
 * Anthropic pricing view — thin derivation over the canonical registry.
 *
 * Public API matches what `provider-runtime/.../anthropic-api.js`
 * previously inlined (MODEL_PRICES, MODEL_ALIAS, resolveModel, priceFor,
 * computeCost), so this can be imported and re-exported without caller
 * changes.
 *
 * USD per million tokens. Cache-write tokens billed at 1.25× input rate
 * (5-min ephemeral); cache-read tokens billed at 0.1× input rate.
 * Source: Anthropic pricing page. Update registry.js when prices change.
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
 * Return the pricing object for a model id. Falls back to _default for
 * unknown ids (e.g. a future model id not yet in the registry).
 */
declare function priceFor(modelId: string): ModelPricing;
/**
 * Compute USD cost for an Anthropic completion.
 *
 * Cache-write tokens (cache_creation_input_tokens) billed at 1.25× input
 * rate; cache-read tokens (cache_read_input_tokens) billed at 0.1× input
 * rate. Returns a number (not an object).
 *
 * Return shape matches the existing anthropic-api.js behavior exactly:
 * a plain number representing total USD cost.
 */
declare function computeCost(usage: Record<string, unknown> | null | undefined, modelId: string): number;
export { MODEL_PRICES, MODEL_ALIAS, DEFAULT_MODEL, resolveModel, priceFor, computeCost, };
