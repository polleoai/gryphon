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
export {};
