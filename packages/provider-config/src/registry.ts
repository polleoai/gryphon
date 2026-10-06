/**
 * Canonical model registry for Gryphon.
 *
 * Single source of truth for: pricing, aliases, context windows, cold-start
 * budgets, dropdown labels, vendor-specific subsets (e.g. Codex CLI's
 * ChatGPT-auth whitelist), and the legacy-alias migration table.
 *
 * The per-vendor pricing files (`pricing/openai.js`, `pricing/google.js`,
 * `pricing/anthropic.js`) and the plugin-shell tables (`MODELS`,
 * `MODEL_CONTEXT`, `COLD_START_BUDGET_MS`, `MODEL_ALIAS_MIGRATION`) all
 * derive from this registry. Adding a new model = editing this file only.
 *
 * **Probe discipline**: no model lands here without a successful probe
 * via `scripts/probe-model.sh <vendor> <id>`. The commit message must
 * include the probe verdict.
 */

// Why concrete IDs (e.g. "claude-sonnet-4-6") instead of aliases ("sonnet")?
//
// The claude-code CLI's alias resolution depends on the installed CLI
// version: a host CLI binary pinned to a pre-1M-window Sonnet would resolve
// `sonnet` to Sonnet 4.5 (200K context), causing "Prompt is too long"
// errors in long-context vaults. Concrete IDs are version-stable and the
// resolved version is captured from the `system.init` stream event for
// display in the UI. This decision applies to MODEL entries below; the
// LEGACY_ALIAS_MIGRATION table further down handles persisted-settings
// rewrites for users who chose the now-removed alias values.
const MODELS = [
  // Dropdown policy (2026-10): each vendor's dropdown shows only its current
  // lineup. Superseded models that the vendor still serves stay here WITHOUT
  // a `dropdown` entry, so cost estimates for them stay correct; persisted
  // settings naming them are moved to a successor on load via
  // RETIRED_MODEL_MIGRATION below. Models with an announced vendor shutdown
  // are removed outright (and also migrated).
  //
  // Why migrate the hidden ones instead of leaving them pinned: the chat
  // toolbar renders the vendor default's label for any id outside the
  // dropdown while the runtime still spawns the persisted id — a pinned
  // hidden model would run under another model's name.

  // ─── Anthropic ────────────────────────────────────────────────────────
  // Current lineup. Verified 2026-10-05 with a real completion:
  //   `claude --model <id> -p` → result "OK", modelUsage keyed by <id>.
  {
    // Still Active; retirement "not sooner than 2026-10-15" — no successor
    // Haiku has been announced, so it stays until Anthropic names one.
    id: "claude-haiku-4-5",
    vendor: "anthropic",
    pricing: { input: 1.00, output: 5.00 },
    dropdown: { label: "Haiku 4.5", desc: "Fast, cheapest (200K)" },
    contextTokens: 200_000,
    coldStartMs: 30_000,
  },
  {
    // Verified: probe-model.sh anthropic claude-sonnet-5-5 → ok
    id: "claude-sonnet-5-5",
    vendor: "anthropic",
    pricing: { input: 2.00, output: 10.00 },
    dropdown: { label: "Sonnet 5.5", desc: "Balanced (1M)" },
    contextTokens: 1_000_000,
    coldStartMs: 90_000,
    isDefault: true,
  },
  {
    // Anthropic's "start here" model. Cheaper than Opus 5 ($4/$20 vs $5/$25).
    // Verified: probe-model.sh anthropic claude-opus-5-5 → ok
    id: "claude-opus-5-5",
    vendor: "anthropic",
    pricing: { input: 4.00, output: 20.00 },
    dropdown: { label: "Opus 5.5", desc: "Top Opus tier (1M)" },
    contextTokens: 1_000_000,
    coldStartMs: 180_000,
  },
  {
    // Runtime special-casing (always-on thinking, refusal fallbacks) lives
    // in provider-runtime, not here — this file is catalog-only.
    // Verified: probe-model.sh anthropic claude-fable-5-1 → ok
    id: "claude-fable-5-1",
    vendor: "anthropic",
    pricing: { input: 10.00, output: 50.00 },
    dropdown: { label: "Fable 5.1", desc: "Most capable (1M)" },
    contextTokens: 1_000_000,
    coldStartMs: 180_000,
  },
  // Superseded, still served (Anthropic "Legacy"). Prices per
  // platform.claude.com/docs/en/about-claude/pricing as of 2026-10-05.
  { id: "claude-sonnet-4-6", vendor: "anthropic", pricing: { input: 3.00, output: 15.00 }, contextTokens: 1_000_000, coldStartMs: 90_000 },
  // Sonnet 5's $2/$10 launch rate became its standard price (the scheduled
  // 2026-09-01 increase to $3/$15 was cancelled).
  { id: "claude-sonnet-5",   vendor: "anthropic", pricing: { input: 2.00, output: 10.00 }, contextTokens: 1_000_000, coldStartMs: 90_000 },
  { id: "claude-opus-4-6",   vendor: "anthropic", pricing: { input: 5.00, output: 25.00 }, contextTokens: 1_000_000, coldStartMs: 180_000 },
  { id: "claude-opus-4-7",   vendor: "anthropic", pricing: { input: 5.00, output: 25.00 }, contextTokens: 1_000_000, coldStartMs: 180_000 },
  { id: "claude-opus-4-8",   vendor: "anthropic", pricing: { input: 5.00, output: 25.00 }, contextTokens: 1_000_000, coldStartMs: 180_000 },
  { id: "claude-opus-5",     vendor: "anthropic", pricing: { input: 5.00, output: 25.00 }, contextTokens: 1_000_000, coldStartMs: 180_000 },
  { id: "claude-fable-5",    vendor: "anthropic", pricing: { input: 10.00, output: 50.00 }, contextTokens: 1_000_000, coldStartMs: 180_000 },

  // ─── OpenAI ───────────────────────────────────────────────────────────
  // Pricing is OpenAI's SHORT-CONTEXT tier. GPT-5.6 and GPT-6 price by
  // context length (long context roughly doubles input), and this registry
  // has one flat rate per model — long-context turns under-report cost.
  // A context-aware pricing shape would be a schema change, not a per-model fix.
  //
  // Codex CLI with ChatGPT-account auth rejects most ids server-side ("The
  // '<id>' model is not supported when using Codex with a ChatGPT account").
  // Probed 2026-10-05 for real completions:
  //   codex 0.145.0: ✓ gpt-5.6-terra   ✗ gpt-6-luna  ✗ gpt-6.1-sol  ✗ gpt-6-astra
  //   codex 0.160.1: ✓ gpt-6-luna      ✗ gpt-6.1-sol ✗ gpt-6-sol    ✗ gpt-6-astra
  // So support depends on the CLIENT version, not only the model — the reason
  // the Codex default stays on gpt-5.6-terra (works on old and new clients).
  // Codex authed with an OPENAI_API_KEY is NOT subject to this restriction.
  {
    // Verified 2026-10-05: real completion via the OpenAI Responses API
    // (API key) → "OK", model "gpt-6-astra". codex-ChatGPT rejects it.
    id: "gpt-6-astra",
    vendor: "openai",
    pricing: { input: 10.00, output: 50.00, cached_input: 1.00 },
    dropdown: { label: "GPT-6 Astra", desc: "Most capable" },
  },
  {
    // Verified 2026-10-05: real completion via the OpenAI Responses API
    // (API key) → "OK", model "gpt-6.1-sol". codex-ChatGPT rejects it.
    id: "gpt-6.1-sol",
    vendor: "openai",
    pricing: { input: 2.00, output: 10.00, cached_input: 0.10 },
    dropdown: { label: "GPT-6.1 Sol", desc: "Balanced (default)" },
    isDefault: true,
  },
  {
    // Verified: real completion via codex 0.160.1 → "OK".
    // NOT codexCliSupported: Codex 0.145.0 (still installed in the wild —
    // it was on the release machine) gets "not supported when using Codex
    // with a ChatGPT account", and Gryphon cannot see the client version.
    // Flagging it would put a failing default in front of older clients
    // (dropdown, fallback picker, gpt-5.6-luna migration). Re-flag when a
    // min-client-version check exists.
    id: "gpt-6-luna",
    vendor: "openai",
    pricing: { input: 0.10, output: 0.50, cached_input: 0.01 },
    dropdown: { label: "GPT-6 Luna", desc: "Fastest, cheapest" },
  },
  {
    // Kept in the dropdown although superseded: it is the only balanced
    // model Codex's ChatGPT auth accepts on every client version probed.
    // Verified: real completion via codex 0.145.0 → "OK"
    id: "gpt-5.6-terra",
    vendor: "openai",
    pricing: { input: 2.00, output: 12.00, cached_input: 0.20 },
    dropdown: { label: "GPT-5.6 Terra", desc: "Balanced, works with Codex sign-in" },
    codexCliSupported: true,
  },
  // Superseded, no shutdown announced — hidden, priced, migrated.
  // `codexCliSupported` is kept on the ones Codex accepted so a Codex user
  // mid-migration is never coerced away from a working model.
  { id: "gpt-5.6-luna", vendor: "openai", pricing: { input: 0.20, output: 1.20, cached_input: 0.02 }, codexCliSupported: true },
  { id: "gpt-5.5",      vendor: "openai", pricing: { input: 5.00, output: 30.00, cached_input: 0.50 }, codexCliSupported: true },
  { id: "gpt-5.4",      vendor: "openai", pricing: { input: 2.50, output: 15.00, cached_input: 0.25 }, codexCliSupported: true },
  { id: "gpt-5.4-mini", vendor: "openai", pricing: { input: 0.75, output: 4.50, cached_input: 0.075 }, codexCliSupported: true },
  { id: "gpt-4o",       vendor: "openai", pricing: { input: 2.50, output: 10.00, cached_input: 1.25 } },
  { id: "gpt-4o-mini",  vendor: "openai", pricing: { input: 0.15, output: 0.60, cached_input: 0.075 } },
  { id: "gpt-4.1",      vendor: "openai", pricing: { input: 2.00, output: 8.00, cached_input: 0.50 } },
  { id: "gpt-4.1-mini", vendor: "openai", pricing: { input: 0.40, output: 1.60, cached_input: 0.10 } },
  // REMOVED (vendor shutdown announced — developers.openai.com deprecations):
  //   2026-10-23: o3-mini, o4-mini, gpt-4.1-nano
  //   2026-12-11: gpt-5, gpt-5-mini, o3
  // Migrated via RETIRED_MODEL_MIGRATION.

  // ─── Google ───────────────────────────────────────────────────────────
  // Modality-specific pricing (audio inputs cost more on Flash) is
  // approximated at the text/image/video rate.
  //
  // Gemini 3.6–3.8 Flash run at a promotional $0.75/$3.75 through
  // 2026-12-31. The STANDARD rate is used here: the registry is not
  // time-aware, and a promo price would under-report cost once it lapses.
  //
  // Probed 2026-10-05 through the Antigravity CLI (the gemini CLI is dead on
  // the Code Assist individuals tier). agy requires `--effort` for these:
  //   agy --model gemini-3.8-flash --effort medium → "OK"
  //   agy --model gemini-3.7-flash --effort medium → "OK"
  //
  // `antigravityCliSupported` marks ids agy's own catalog accepts (`agy
  // models`, 2026-10-05). The antigravity-cli provider reuses this vendor's
  // dropdown, so without the filter it offered ids agy rejects outright:
  // gemini-3.5-flash-lite (absent from agy's catalog) and
  // gemini-3.1-pro-preview (agy calls it `gemini-3.1-pro`).
  {
    // "Most intelligent Flash model, engineered for long-horizon software
    // engineering" (Google). GA 2026-09-02.
    id: "gemini-3.8-flash",
    vendor: "google",
    pricing: { input: 1.50, output: 7.50, cached_input: 0.15 },
    dropdown: { label: "Gemini 3.8 Flash", desc: "Most capable Flash" },
    antigravityCliSupported: true,
  },
  {
    // GA 2026-08-13, Google's "high-speed, efficient" Flash.
    id: "gemini-3.7-flash",
    vendor: "google",
    pricing: { input: 1.50, output: 7.50, cached_input: 0.15 },
    dropdown: { label: "Gemini 3.7 Flash", desc: "Balanced (default)" },
    isDefault: true,
    antigravityCliSupported: true,
  },
  {
    // Google's named successor to gemini-3.1-flash-lite (shutdown 2027-05-07).
    // Verified 2026-10-05: real completion via the Gemini API (API key) →
    // "OK", modelVersion "gemini-3.5-flash-lite". Not in agy's catalog.
    id: "gemini-3.5-flash-lite",
    vendor: "google",
    // Google publishes no caching rate for this model; 10% of input matches
    // every other Gemini entry. Cached tokens are billed at the full input
    // rate by the cost calculator anyway (see pricing/google.ts) — this
    // field is telemetry only.
    pricing: { input: 0.30, output: 2.50, cached_input: 0.03 },
    dropdown: { label: "Gemini 3.5 Flash-Lite", desc: "Cheapest" },
  },
  {
    // Still the only Pro tier, still preview on the Gemini API. NB agy's
    // catalog names it `gemini-3.1-pro` (no -preview) — pre-existing
    // mismatch for the antigravity-cli provider, not changed here.
    id: "gemini-3.1-pro-preview",
    vendor: "google",
    pricing: { input: 2.00, output: 12.00, cached_input: 0.20 },
    dropdown: { label: "Gemini 3.1 Pro", desc: "Preview, deepest reasoning" },
  },
  // Superseded — hidden, priced, migrated. The 2.5 family is limited to
  // existing users, so it can no longer be anyone's default.
  { id: "gemini-3.6-flash",       vendor: "google", pricing: { input: 1.50, output: 7.50, cached_input: 0.15 }, antigravityCliSupported: true },
  { id: "gemini-3.5-flash",       vendor: "google", pricing: { input: 1.50, output: 9.00, cached_input: 0.15 } },
  { id: "gemini-3-flash-preview", vendor: "google", pricing: { input: 0.50, output: 3.00, cached_input: 0.05 } },
  { id: "gemini-3.1-flash-lite",  vendor: "google", pricing: { input: 0.25, output: 1.50, cached_input: 0.025 } },
  { id: "gemini-2.5-pro",         vendor: "google", pricing: { input: 1.25, output: 10.00, cached_input: 0.125 } },
  { id: "gemini-2.5-flash",       vendor: "google", pricing: { input: 0.30, output: 2.50, cached_input: 0.03 } },
  { id: "gemini-2.5-flash-lite",  vendor: "google", pricing: { input: 0.10, output: 0.40, cached_input: 0.01 } },
];

// Vendor-specific fallback pricing for unknown ids. Tracks each vendor's
// default model, so an unrecognised id is estimated at the rate of the
// model a user would most likely have picked instead.
const VENDOR_FALLBACK_PRICING: Record<string, Record<string, number>> = {
  anthropic: { input: 2.00, output: 10.00 },
  openai:    { input: 2.00, output: 10.00, cached_input: 0.10 },
  google:    { input: 1.50, output: 7.50, cached_input: 0.15 },
};

// Cross-vendor aliases — Anthropic-style names (haiku/sonnet/opus) map
// to per-vendor counterparts so a user switching Provider keeps a
// working model. `opus` on OpenAI stays on the balanced tier (gpt-6.1-sol,
// NOT gpt-6-astra at $10/$50) — cost-ceiling decision; on Anthropic and
// Google it points at the top general tier.
const CROSS_VENDOR_ALIASES: Record<string, Record<string, string>> = {
  haiku:      { anthropic: "claude-haiku-4-5",  openai: "gpt-6-luna",   google: "gemini-3.5-flash-lite" },
  sonnet:     { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol",  google: "gemini-3.7-flash" },
  opus:       { anthropic: "claude-opus-5-5",   openai: "gpt-6.1-sol",  google: "gemini-3.1-pro-preview" },
  "opus[1m]": { anthropic: "claude-opus-5-5",   openai: "gpt-6.1-sol",  google: "gemini-3.1-pro-preview" },
};

// Legacy-alias migration: users whose persisted `settings.model` is one
// of the old aliases get rewritten to the concrete ID at plugin load.
// Keyed by vendor so other vendors can join later if they grow legacy
// aliases (OpenAI and Google have no in-the-wild legacy ids today —
// the omission is intentional, not a TODO).
const LEGACY_ALIAS_MIGRATION: Record<string, Record<string, string>> = {
  anthropic: {
    "haiku":     "claude-haiku-4-5",
    "sonnet":    "claude-sonnet-5-5",
    "opus":      "claude-opus-5-5",
    "opus[1m]":  "claude-opus-5-5",
  },
};

// Retired-model migration: a persisted model id that is no longer in its
// vendor's dropdown (hidden-but-served, or removed after a vendor
// shutdown) is rewritten to its successor at plugin load. Flat, because
// ids are already vendor-namespaced. Successors follow each vendor's own
// recommended replacement, carried forward to the current lineup.
//
// Every value MUST be an id that is in its vendor's dropdown — a successor
// that is itself retired would leave the user on a hidden model (asserted
// in tests/registry.test.ts).
const RETIRED_MODEL_MIGRATION: Record<string, string> = {
  // Anthropic — by tier.
  "claude-sonnet-4-6":      "claude-sonnet-5-5",
  "claude-sonnet-5":        "claude-sonnet-5-5",
  "claude-opus-4-6":        "claude-opus-5-5",
  "claude-opus-4-7":        "claude-opus-5-5",
  "claude-opus-4-8":        "claude-opus-5-5",
  "claude-opus-5":          "claude-opus-5-5",
  "claude-fable-5":         "claude-fable-5-1",
  // OpenAI — removed (vendor shutdown announced).
  "o3":                     "gpt-6.1-sol",
  "o3-mini":                "gpt-6.1-sol",
  "o4-mini":                "gpt-5.6-terra",
  "gpt-5":                  "gpt-6.1-sol",
  "gpt-5-mini":             "gpt-5.6-terra",
  "gpt-4.1-nano":           "gpt-6-luna",
  // OpenAI — hidden. A Codex user landing on a Codex-unsupported successor
  // (gpt-6.1-sol, gpt-6-luna) is still safe: coerceToCodexCliModel maps it
  // to the Codex default at spawn, and the toolbar mirrors that resolver.
  "gpt-5.5":                "gpt-6.1-sol",
  "gpt-5.4":                "gpt-6.1-sol",
  "gpt-5.4-mini":           "gpt-5.6-terra",
  "gpt-5.6-luna":           "gpt-6-luna",
  "gpt-4o":                 "gpt-6.1-sol",
  "gpt-4.1":                "gpt-6.1-sol",
  "gpt-4o-mini":            "gpt-6-luna",
  "gpt-4.1-mini":           "gpt-6-luna",
  // Google.
  "gemini-3.6-flash":       "gemini-3.7-flash",
  "gemini-3.5-flash":       "gemini-3.7-flash",
  "gemini-3-flash-preview": "gemini-3.7-flash",
  "gemini-2.5-flash":       "gemini-3.7-flash",
  "gemini-2.5-pro":         "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite":  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite":  "gemini-3.5-flash-lite",
};

// ─────────────── freeze all data tables at module init ────────────────
//
// Prevents consumers from accidentally corrupting the in-process registry
// via `registry.allModels().push(...)` or direct property mutation.
// Both the arrays AND their individual entries are frozen; allModels()
// returns a shallow copy so callers can re-order/filter without affecting
// the canonical source.
MODELS.forEach((m) => Object.freeze(m));
Object.freeze(MODELS);
Object.freeze(VENDOR_FALLBACK_PRICING);
for (const k of Object.keys(VENDOR_FALLBACK_PRICING)) Object.freeze(VENDOR_FALLBACK_PRICING[k]);
Object.freeze(CROSS_VENDOR_ALIASES);
for (const k of Object.keys(CROSS_VENDOR_ALIASES)) Object.freeze(CROSS_VENDOR_ALIASES[k]);
Object.freeze(LEGACY_ALIAS_MIGRATION);
for (const k of Object.keys(LEGACY_ALIAS_MIGRATION)) Object.freeze(LEGACY_ALIAS_MIGRATION[k]);
Object.freeze(RETIRED_MODEL_MIGRATION);

// ───────────────────────────── lookup API ─────────────────────────────

// Tracks vendors already warned about so each unknown vendor emits at most
// one console.warn per Node process (module-level, survives require cache).
const _warnedUnknownVendors = new Set();

function _warnUnknownVendor(fn: string, vendor: string) {
  if (_warnedUnknownVendors.has(vendor)) return;
  _warnedUnknownVendors.add(vendor);
  console.warn(`[gryphon/registry] ${fn}: unknown vendor "${vendor}" — falling back. Add to registry.js if this is intentional.`);
}

function allModels() {
  return [...MODELS];   // shallow copy of frozen entries; caller can re-order without corrupting registry
}

function modelsByVendor(vendor: string) {
  return MODELS.filter((m) => m.vendor === vendor);
}

function _findEntry(modelId: string) {
  return MODELS.find((m) => m.id === modelId);
}

function priceFor(modelId: string, vendor: string) {
  const entry = _findEntry(modelId);
  if (entry && entry.pricing) return entry.pricing;
  if (VENDOR_FALLBACK_PRICING[vendor]) return VENDOR_FALLBACK_PRICING[vendor];
  // Unknown vendor: throw rather than silently use OpenAI pricing. The
  // warn-once helper was insufficient — a single warning is easily missed
  // while every subsequent call silently mis-bills.
  throw new Error(
    `priceFor: unknown vendor "${vendor}". Add to VENDOR_FALLBACK_PRICING in registry.js, ` +
    `or pass a known vendor (anthropic|openai|google).`,
  );
}

/**
 * Resolve an alias or concrete model id to a vendor-specific concrete id.
 *
 * Three resolution paths in priority order:
 *   1. Cross-vendor alias (haiku/sonnet/opus/opus[1m]) → vendor-specific id.
 *   2. Identity passthrough — input is already a concrete id for the vendor.
 *   3. Unknown → returns null (caller decides whether to fall back).
 *
 * @returns {string|null} concrete model id, or null if unresolvable.
 */
function aliasFor(alias: string, vendor: string) {
  const crossVendor = CROSS_VENDOR_ALIASES[alias];
  if (crossVendor && crossVendor[vendor]) return crossVendor[vendor];
  // If alias is already a known id for this vendor, pass through.
  const entry = _findEntry(alias);
  if (entry && entry.vendor === vendor) return alias;
  return null;
}

function defaultModelFor(vendor: string) {
  const entry = modelsByVendor(vendor).find((m) => m.isDefault);
  if (!entry) {
    _warnUnknownVendor("defaultModelFor", vendor);
    return null;
  }
  return entry.id;
}

function dropdownFor(vendor: string) {
  return modelsByVendor(vendor)
    .filter((m) => m.dropdown)
    .map((m) => ({ id: m.id, label: m.dropdown!.label, desc: m.dropdown!.desc || "" }));
}

function isKnownModel(modelId: string) {
  return Boolean(_findEntry(modelId));
}

function contextTokensFor(modelId: string) {
  const entry = _findEntry(modelId);
  return entry && entry.contextTokens != null ? entry.contextTokens : null;
}

function coldStartMsFor(modelId: string) {
  const entry = _findEntry(modelId);
  return entry && entry.coldStartMs != null ? entry.coldStartMs : null;
}

function legacyAliasMigrationFor(vendor: string) {
  return LEGACY_ALIAS_MIGRATION[vendor] || {};
}

/**
 * Successor for a retired model id, or null when the id is current or
 * unknown. Unknown ids are deliberately left alone: forward-compat for
 * brand-new vendor ids depends on unrecognised names passing through.
 */
function retiredModelSuccessor(modelId: string): string | null {
  return Object.prototype.hasOwnProperty.call(RETIRED_MODEL_MIGRATION, modelId)
    ? RETIRED_MODEL_MIGRATION[modelId]
    : null;
}

function antigravityCliSupportedModels() {
  return new Set(
    MODELS.filter((m) => m.vendor === "google" && m.antigravityCliSupported).map((m) => m.id),
  );
}

function codexCliSupportedModels() {
  return new Set(
    MODELS.filter((m) => m.vendor === "openai" && m.codexCliSupported).map((m) => m.id),
  );
}

module.exports = {
  // Data tables (exported for tests / advanced consumers)
  MODELS,
  VENDOR_FALLBACK_PRICING,
  CROSS_VENDOR_ALIASES,
  LEGACY_ALIAS_MIGRATION,
  RETIRED_MODEL_MIGRATION,

  // Lookup API
  allModels,
  modelsByVendor,
  priceFor,
  aliasFor,
  defaultModelFor,
  dropdownFor,
  isKnownModel,
  contextTokensFor,
  coldStartMsFor,
  legacyAliasMigrationFor,
  retiredModelSuccessor,
  codexCliSupportedModels,
  antigravityCliSupportedModels,
};
