/**
 * Gemini per-model pricing + cost calculator.
 *
 * USD per million tokens. Update when Google's published pricing changes
 * (https://ai.google.dev/gemini-api/docs/pricing).
 *
 * Some Gemini models tier pricing by prompt length (≤200K vs >200K input
 * tokens). For v1.2 we model the ≤200K rate — the typical Obsidian case.
 * The >200K multiplier applies for the full session and is tracked as a
 * v1.3 follow-up (would require threading prompt length into computeCost).
 *
 * Modality-specific pricing (audio inputs cost more than text/image/video
 * on Flash-tier models) is also approximated at the text/image/video rate.
 * Audio-input pricing surfaces in Stage 3+ if/when the user uses audio
 * tool inputs — Gryphon currently routes only text/image content.
 *
 * The `cached_input` field is tracked separately for telemetry but the
 * v1.2 cost calculator bills cached tokens at the full input rate per
 * the design-spec decision (consistent with anthropic-api + openai-api
 * — switch to applying the discount when v1.3 standardizes the policy).
 */

const MODEL_PRICES = {
  // Gemini 3.x family — preview as of 2026-Q2
  "gemini-3.1-pro-preview":  { input: 2.00, output: 12.00, cached_input: 0.20 },
  "gemini-3-flash-preview":  { input: 0.50, output: 3.00,  cached_input: 0.05 },

  // Gemini 2.5 family — current GA tier
  "gemini-2.5-pro":          { input: 1.25, output: 10.00, cached_input: 0.125 },
  "gemini-2.5-flash":        { input: 0.30, output: 2.50,  cached_input: 0.03  },
  "gemini-2.5-flash-lite":   { input: 0.10, output: 0.40,  cached_input: 0.01  },

  // Conservative default for unknown ids — assume gemini-2.5-flash pricing
  // (the general-purpose mid-tier; symmetric over/under estimation across
  // the unknown-model surface).
  "_default":                { input: 0.30, output: 2.50,  cached_input: 0.03  },
};

const MODEL_ALIAS = {
  // Cross-vendor aliases — Anthropic-style names map to Gemini counterparts
  // when a user switches Provider from Anthropic → Google. Avoid pointing
  // at preview models (gemini-3.x) because previews churn faster than GA.
  "haiku":      "gemini-2.5-flash-lite",   // cheapest
  "sonnet":     "gemini-2.5-flash",        // balanced
  "opus":       "gemini-2.5-pro",          // most capable GA
  "opus[1m]":   "gemini-2.5-pro",          // 1M-context flag handled at request time

  // Gemini native names pass through unchanged
  "gemini-3.1-pro-preview":  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview":  "gemini-3-flash-preview",
  "gemini-2.5-pro":          "gemini-2.5-pro",
  "gemini-2.5-flash":        "gemini-2.5-flash",
  "gemini-2.5-flash-lite":   "gemini-2.5-flash-lite",
};

const DEFAULT_MODEL = "gemini-2.5-flash";

function resolveModel(alias) {
  if (!alias) return DEFAULT_MODEL;
  return MODEL_ALIAS[alias] || alias;
}

/**
 * Provider-strict resolver — mirrors `resolveModel` but rejects cross-vendor
 * leakage. Used by the GoogleProvider constructor so that a stale
 * `settings.model = "gpt-4o-mini"` (carried over from prior OpenAI use, with
 * no Settings → Provider onChange to fire `_resetModelForProvider`) does NOT
 * reach Gemini's API verbatim and 400. Forward-compat preserved for ids that
 * LOOK like Gemini ids (gemini- prefix) — those pass through even if not yet
 * in MODEL_PRICES, so a brand-new model name works without a code update.
 *
 * Issue #27.
 */
function coerceToVendorModel(alias) {
  const resolved = resolveModel(alias);
  if (MODEL_PRICES[resolved]) return resolved;
  // Forward-compat: ids that look like Gemini's namespace pass through.
  if (typeof resolved === "string" && /^gemini-/i.test(resolved)) return resolved;
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
  if (!usage) return { cost: 0, breakdown: { input: 0, output: 0, cachedTokens: 0 } };
  const p = priceFor(modelId);
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const cachedTokens = usage.cachedContentTokenCount || 0;

  const inputCost  = (inputTokens / 1_000_000) * p.input;   // cached billed at full rate (v1.2 decision)
  const outputCost = (outputTokens / 1_000_000) * p.output;

  return {
    cost: inputCost + outputCost,
    breakdown: { input: inputCost, output: outputCost, cachedTokens },
  };
}

function getModelDropdownOptions() {
  // Newest first within each tier; legacy/preview clearly labeled.
  return [
    { id: "gemini-2.5-flash",       label: "Gemini 2.5 Flash · Balanced (default)" },
    { id: "gemini-2.5-pro",         label: "Gemini 2.5 Pro · Most capable" },
    { id: "gemini-2.5-flash-lite",  label: "Gemini 2.5 Flash-Lite · Cheap / fast" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro · Preview (newest)" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash · Preview" },
  ];
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
