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

const registry = require("../registry");

// Guard against NaN / Infinity token counts from malformed usage objects.
// `|| 0` passes NaN through as 0 only after the logical-OR coercion, which
// means NaN || 0 = 0 — but that silently zeroes a bad field and lets the
// budget cap see $0 cost, bypassing the per-call ceiling. Explicit finite
// check makes the intent clear and future-proofs against undefined fields.
function _finite(n: unknown): number {
  return (typeof n === "number" && Number.isFinite(n)) ? n : 0;
}

// Derive MODEL_PRICES object keyed by model id (back-compat shape).
// Includes `_default` fallback for unknown model ids — uses Sonnet
// (the mid-tier reference) so cost estimates are never wildly off.
const MODEL_PRICES: Record<string, any> = (() => {
  const out: Record<string, any> = {};
  for (const m of registry.modelsByVendor("anthropic")) {
    out[m.id] = m.pricing;
  }
  out._default = registry.VENDOR_FALLBACK_PRICING.anthropic;
  return out;
})();

// Derive cross-vendor + native-passthrough alias map.
// Cross-vendor: haiku/sonnet/opus/opus[1m] → concrete Anthropic ids.
// Native passthrough: concrete id → itself (so resolveModel is a no-op
// for callers already holding a concrete id).
const MODEL_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [alias, perVendor] of Object.entries(registry.CROSS_VENDOR_ALIASES)) {
    const pv = perVendor as Record<string, string>;
    if (pv.anthropic) out[alias] = pv.anthropic;
  }
  for (const m of registry.modelsByVendor("anthropic")) {
    if (out[m.id] && out[m.id] !== m.id) {
      throw new Error(
        `pricing/anthropic.js: alias collision — concrete id "${m.id}" would overwrite ` +
        `cross-vendor mapping "${m.id}" → "${out[m.id]}". Rename either the model ` +
        `id or the cross-vendor alias in registry.js.`,
      );
    }
    out[m.id] = m.id;
  }
  return out;
})();

const DEFAULT_MODEL = registry.defaultModelFor("anthropic");

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
function resolveModel(alias: string | null | undefined): string {
  if (!alias) return DEFAULT_MODEL;
  return MODEL_ALIAS[alias] || alias;
}

/**
 * Return the pricing object for a model id. Falls back to _default for
 * unknown ids (e.g. a future model id not yet in the registry).
 */
function priceFor(modelId: string): Record<string, number> {
  return MODEL_PRICES[modelId] || MODEL_PRICES._default;
}

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
function computeCost(usage: Record<string, unknown> | null | undefined, modelId: string): number {
  if (!usage) return 0;
  const p = priceFor(modelId);
  const inputTokens =
    _finite(usage.input_tokens) +
    _finite(usage.cache_creation_input_tokens) * 1.25 +  // write premium
    _finite(usage.cache_read_input_tokens) * 0.1;        // read discount
  const outputTokens = _finite(usage.output_tokens);
  return (inputTokens / 1_000_000) * p.input +
         (outputTokens / 1_000_000) * p.output;
}

module.exports = {
  MODEL_PRICES,
  MODEL_ALIAS,
  DEFAULT_MODEL,
  resolveModel,
  priceFor,
  computeCost,
};
