/**
 * OpenAI per-model pricing + cost calculator.
 *
 * USD per million tokens. Update when OpenAI's pricing changes
 * (https://openai.com/api/pricing/).
 *
 * The `cached_input` field is tracked **separately** for telemetry but
 * the v1.2 cost calculator bills cached tokens at the full input rate.
 * Per the design-spec open-question decision, we hold the discount in
 * reserve until OpenAI's public pricing for prompt-cache hits is stable
 * across SKUs. Once formalized, switch the cost calculator to apply the
 * cached_input rate without changing the table shape.
 *
 * Model aliases (gpt-4o-mini etc.) resolve via MODEL_ALIAS so the chat
 * panel's dropdown can use short, friendly labels while the API gets the
 * concrete vendor model id.
 */

// Pricing source: developers.openai.com/api/docs/models/<model> (verified
// 2026-05-02 against the live pricing pages for the gpt-5 family). gpt-4o
// and gpt-4.1 rates retained for older user setups + as the historical
// default-tier reference. Update whenever OpenAI publishes a price change.
const MODEL_PRICES = {
  // GPT-5 family (current-tier, post-2026-Q1 — what you'd pick for new work)
  // gpt-5.5: prompts > 272K input tokens are priced at 2× input / 1.5× output
  // for the full session — NOT modeled here (computeCost would need a context-
  // length input to apply the multiplier). Tracked as a v1.3 follow-up; for
  // typical prompts <272K the flat rate below is correct.
  "gpt-5":             { input: 1.25,  output: 10.00, cached_input: 0.125 },
  "gpt-5-mini":        { input: 0.25,  output: 2.00,  cached_input: 0.025 },
  "gpt-5.4":           { input: 2.50,  output: 15.00, cached_input: 0.25  },
  "gpt-5.4-mini":      { input: 0.75,  output: 4.50,  cached_input: 0.075 },
  "gpt-5.5":           { input: 5.00,  output: 30.00, cached_input: 0.50  },

  // GPT-4o family (still supported; cheaper for plain chat)
  "gpt-4o":            { input: 2.50,  output: 10.00, cached_input: 1.25  },
  "gpt-4o-mini":       { input: 0.15,  output: 0.60,  cached_input: 0.075 },

  // GPT-4.1 family
  "gpt-4.1":           { input: 2.00,  output: 8.00,  cached_input: 0.50  },
  "gpt-4.1-mini":      { input: 0.40,  output: 1.60,  cached_input: 0.10  },
  "gpt-4.1-nano":      { input: 0.10,  output: 0.40,  cached_input: 0.025 },

  // o-series reasoning
  "o3":                { input: 2.00,  output: 8.00,  cached_input: 0.50  },
  "o3-mini":           { input: 1.10,  output: 4.40,  cached_input: 0.55  },
  "o4-mini":           { input: 1.10,  output: 4.40,  cached_input: 0.275 },

  // Conservative default for unknown models — assume gpt-5.4-mini pricing
  // (the new general-purpose mid-tier; not the cheapest, not the most expensive,
  // so over/under-estimation symmetric across the unknown surface).
  "_default":          { input: 0.75,  output: 4.50,  cached_input: 0.075 },
};

const MODEL_ALIAS = {
  // Friendly cross-vendor aliases — Anthropic-style names map to GPT-5-tier
  // counterparts. When a user switches Provider from Anthropic → OpenAI
  // their settings.model carries over and these aliases keep behavior sane.
  "haiku":      "gpt-5-mini",      // cheap + fast (was gpt-4o-mini before gpt-5 family)
  "sonnet":     "gpt-5.4-mini",    // balanced default (was gpt-4o)
  "opus":       "gpt-5.4",         // most capable general model (was gpt-4.1)
  "opus[1m]":   "gpt-5.4",         // 1M-context flag handled at request layer

  // OpenAI native names pass through unchanged
  "gpt-5":          "gpt-5",
  "gpt-5-mini":     "gpt-5-mini",
  "gpt-5.4":        "gpt-5.4",
  "gpt-5.4-mini":   "gpt-5.4-mini",
  "gpt-5.5":        "gpt-5.5",
  "gpt-4o":         "gpt-4o",
  "gpt-4o-mini":    "gpt-4o-mini",
  "gpt-4.1":        "gpt-4.1",
  "gpt-4.1-mini":   "gpt-4.1-mini",
  "gpt-4.1-nano":   "gpt-4.1-nano",
  "o3":             "o3",
  "o3-mini":        "o3-mini",
  "o4-mini":        "o4-mini",
};

const DEFAULT_MODEL = "gpt-5.4-mini";

function resolveModel(alias) {
  if (!alias) return DEFAULT_MODEL;
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
  if (MODEL_PRICES[resolved]) return resolved;
  if (typeof resolved === "string" && /^(gpt-|o3|o4)/i.test(resolved)) return resolved;
  return DEFAULT_MODEL;
}

/**
 * Subset of OpenAI model ids that work via the Codex CLI when authed
 * with a ChatGPT account (the most common Codex CLI auth path —
 * `codex login` browser flow). Empirically tested 2026-05-09:
 *
 *   ✓ gpt-5.5
 *   ✓ gpt-5.4
 *   ✓ gpt-5.4-mini
 *
 *   ✗ gpt-5, gpt-5-mini   — server-side rejected: "model not supported"
 *   ✗ gpt-4o, gpt-4o-mini — same
 *   ✗ gpt-4.1, gpt-4.1-mini — same
 *   ✗ o3, o3-mini, o4-mini — same
 *
 * Codex CLI authed with an OpenAI API key (OPENAI_API_KEY env var) is
 * NOT subject to this restriction; it can use any model the API
 * supports. This whitelist is a defensive default — it filters the
 * dropdown surface so the most-common ChatGPT-account user doesn't see
 * options that error at spawn time. A user on API-key auth who wants
 * the full list can override via `extraArgs: ["-m", "gpt-5-mini"]`,
 * which bypasses the dropdown entirely.
 *
 * Update this set when ChatGPT subscription tiers change which models
 * Codex CLI surfaces. The runtime `coerceToCodexCliModel` falls back
 * to `gpt-5.4-mini` (the safest member of the supported set) when the
 * user's persisted model isn't in the whitelist.
 */
const CODEX_CLI_SUPPORTED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

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
  if (!usage) return { cost: 0, breakdown: { input: 0, output: 0, cachedTokens: 0 } };
  const p = priceFor(modelId);
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const cachedTokens =
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;

  const inputCost  = (inputTokens / 1_000_000) * p.input;   // cached billed at full rate (v1.2 decision)
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
  // Ordering rule: newest models first within each tier; tiers listed in
  // descending recency. Update whenever OpenAI ships a new model.
  return [
    // GPT-5.5 — flagship as of 2026-Q2
    { id: "gpt-5.5",        label: "GPT-5.5 · Most capable (newest)" },
    // GPT-5.4 family
    { id: "gpt-5.4",        label: "GPT-5.4 · Capable" },
    { id: "gpt-5.4-mini",   label: "GPT-5.4 mini · Balanced (default)" },
    // GPT-5 family
    { id: "gpt-5",          label: "GPT-5 · Older balanced" },
    { id: "gpt-5-mini",     label: "GPT-5 mini · Fast / cheap" },
    // o-series reasoning models
    { id: "o4-mini",        label: "o4-mini · Reasoning (newer)" },
    { id: "o3",             label: "o3 · Deep reasoning" },
    { id: "o3-mini",        label: "o3-mini · Reasoning" },
    // Legacy GPT-4 family — kept for users on older setups
    { id: "gpt-4.1",        label: "GPT-4.1 · Legacy capable" },
    { id: "gpt-4.1-mini",   label: "GPT-4.1 mini · Legacy cheap" },
    { id: "gpt-4o",         label: "GPT-4o · Legacy balanced" },
    { id: "gpt-4o-mini",    label: "GPT-4o mini · Legacy cheap" },
  ];
}

/**
 * Codex-CLI-specific dropdown — filters the OpenAI list to only models
 * confirmed to work with Codex CLI's ChatGPT-account auth path. See the
 * `CODEX_CLI_SUPPORTED_MODELS` block above for the empirically-tested
 * supported set and the rationale.
 */
function getCodexCliModelDropdownOptions() {
  return getModelDropdownOptions().filter((opt) =>
    CODEX_CLI_SUPPORTED_MODELS.has(opt.id)
  );
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
  if (CODEX_CLI_SUPPORTED_MODELS.has(resolved)) return resolved;
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
