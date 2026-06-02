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

const registry = require("../registry");

// Guard against NaN / Infinity token counts (see anthropic.js for rationale).
function _finite(n: unknown): number {
  return (typeof n === "number" && Number.isFinite(n)) ? n : 0;
}

// Derive MODEL_PRICES object keyed by model id (back-compat shape).
// Includes `_default` fallback for unknown model ids.
const MODEL_PRICES: Record<string, any> = (() => {
  const out: Record<string, any> = {};
  for (const m of registry.modelsByVendor("google")) out[m.id] = m.pricing;
  out._default = registry.VENDOR_FALLBACK_PRICING.google;
  return out;
})();

// Derive cross-vendor + native-passthrough alias map.
// Cross-vendor: haiku/sonnet/opus/opus[1m] → concrete Google ids.
// Native passthrough: concrete id → itself (so resolveModel is a no-op
// for callers already holding a concrete id).
const MODEL_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [alias, perVendor] of Object.entries(registry.CROSS_VENDOR_ALIASES)) {
    const pv = perVendor as Record<string, string>;
    if (pv.google) out[alias] = pv.google;
  }
  for (const m of registry.modelsByVendor("google")) {
    if (out[m.id] && out[m.id] !== m.id) {
      throw new Error(
        `pricing/google.js: alias collision — concrete id "${m.id}" would overwrite ` +
        `cross-vendor mapping "${m.id}" → "${out[m.id]}". Rename either the model ` +
        `id or the cross-vendor alias in registry.js.`,
      );
    }
    out[m.id] = m.id;
  }
  return out;
})();

const DEFAULT_MODEL = registry.defaultModelFor("google");

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
 * Provider-strict resolver — mirrors `resolveModel` but rejects cross-vendor
 * leakage. Used by the GoogleProvider constructor so that a stale
 * `settings.model = "gpt-4o-mini"` (carried over from prior OpenAI use) does
 * NOT reach Gemini's API verbatim and 400. Forward-compat preserved for ids
 * that look like Gemini ids (gemini- prefix) — those pass through even if not
 * yet in MODEL_PRICES, so a brand-new model name works without a code update.
 *
 * Issue #27.
 */
function coerceToVendorModel(alias: string | null | undefined): string {
  const resolved = resolveModel(alias);
  if (MODEL_PRICES[resolved]) return resolved;
  // Forward-compat: ids that look like Gemini's namespace pass through.
  if (typeof resolved === "string" && /^gemini-/i.test(resolved)) return resolved;
  // Cross-vendor leak — fall back to this vendor's default.
  return DEFAULT_MODEL;
}

function priceFor(modelId: string): Record<string, number> {
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
function computeCost(usage: Record<string, unknown> | null | undefined, modelId: string) {
  if (!usage) return { cost: 0, breakdown: { input: 0, output: 0, cachedTokens: 0 } };
  const p = priceFor(modelId);
  const inputTokens  = _finite(usage.promptTokenCount);
  const outputTokens = _finite(usage.candidatesTokenCount);
  const cachedTokens = _finite(usage.cachedContentTokenCount);

  const inputCost  = (inputTokens / 1_000_000) * p.input;   // cached billed at full rate (v1.2 decision)
  const outputCost = (outputTokens / 1_000_000) * p.output;

  return {
    cost: inputCost + outputCost,
    breakdown: { input: inputCost, output: outputCost, cachedTokens },
  };
}

function getModelDropdownOptions() {
  return registry.dropdownFor("google").map((o: { id: string; label: string; desc: string }) => ({
    id: o.id,
    label: o.desc ? `${o.label} · ${o.desc}` : o.label,
  }));
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
};
