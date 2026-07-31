"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
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
    // ─── Anthropic ────────────────────────────────────────────────────────
    {
        id: "claude-haiku-4-5",
        vendor: "anthropic",
        pricing: { input: 0.80, output: 4.00 },
        dropdown: { label: "Haiku 4.5", desc: "Fast, cheapest (200K)" },
        contextTokens: 200_000,
        coldStartMs: 30_000,
    },
    {
        id: "claude-sonnet-4-6",
        vendor: "anthropic",
        pricing: { input: 3.00, output: 15.00 },
        dropdown: { label: "Sonnet 4.6", desc: "Balanced (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 90_000,
    },
    {
        // Claude Sonnet 5 — newest Sonnet, near-Opus quality on coding/agentic.
        // Standard $3/$15 used here (NOT the $2/$10 intro rate that expires
        // 2026-08-31 — the registry is not time-aware, so encoding a promo
        // price would over-discount cost estimates once it lapses).
        // Verified: probe-model.sh anthropic claude-sonnet-5 → ok
        id: "claude-sonnet-5",
        vendor: "anthropic",
        pricing: { input: 3.00, output: 15.00 },
        dropdown: { label: "Sonnet 5", desc: "Balanced, newest (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 90_000,
        isDefault: true,
    },
    {
        id: "claude-opus-4-6",
        vendor: "anthropic",
        pricing: { input: 15.00, output: 75.00 },
        dropdown: { label: "Opus 4.6", desc: "Production (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 180_000,
    },
    {
        id: "claude-opus-4-7",
        vendor: "anthropic",
        // Retained in registry (vs. removed) because users may have it
        // pinned in settings.model; dropping it would make isKnownModel()
        // return false and break their persisted preference.
        pricing: { input: 15.00, output: 75.00 },
        dropdown: { label: "Opus 4.7", desc: "Prior flagship (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 180_000,
    },
    {
        id: "claude-opus-4-8",
        vendor: "anthropic",
        pricing: { input: 5.00, output: 25.00 },
        dropdown: { label: "Opus 4.8", desc: "Previous Opus tier (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 180_000,
    },
    {
        // Claude Opus 5 — the current Opus, superseding 4.8 at the SAME price
        // ($5/$25). Anthropic's own guidance is "if you're unsure which model to
        // use, start with Claude Opus 5", so it carries the Opus-tier label here.
        // Verified: probe-model.sh anthropic claude-opus-5 → ok
        id: "claude-opus-5",
        vendor: "anthropic",
        pricing: { input: 5.00, output: 25.00 },
        dropdown: { label: "Opus 5", desc: "Top Opus tier (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 180_000,
    },
    {
        // Claude Fable 5 — Anthropic's most capable widely released model,
        // for the most demanding reasoning / long-horizon agentic work.
        // Priced above the Opus tier. Runtime special-casing (always-on
        // thinking, refusal fallbacks) lives in provider-runtime, not here —
        // this file is catalog-only (pricing / context / label / cold start).
        // Verified: probe-model.sh anthropic claude-fable-5 → ok
        id: "claude-fable-5",
        vendor: "anthropic",
        pricing: { input: 10.00, output: 50.00 },
        dropdown: { label: "Fable 5", desc: "Most capable (1M)" },
        contextTokens: 1_000_000,
        coldStartMs: 180_000,
    },
    // ─── OpenAI ───────────────────────────────────────────────────────────
    // gpt-5.5: prompts > 272K input tokens are priced at 2× input / 1.5×
    // output for the full session — NOT modeled here. Tracked as a v1.3
    // follow-up (would require threading prompt length into computeCost).
    //
    // Codex-CLI ChatGPT-auth whitelist (per `codexCliSupported: true` flag below)
    // Empirically tested 2026-05-09:
    //   ✓ gpt-5.5
    //   ✓ gpt-5.4
    //   ✓ gpt-5.4-mini
    //   ✗ gpt-5, gpt-5-mini       — server-side rejected: "model not supported"
    //   ✗ gpt-4o, gpt-4o-mini     — same
    //   ✗ gpt-4.1, gpt-4.1-mini   — same
    //   ✗ o3, o3-mini, o4-mini    — same
    //
    // Codex CLI authed with an OpenAI API key (OPENAI_API_KEY env var) is NOT
    // subject to this restriction. The whitelist is a defensive default that
    // filters the dropdown surface so the most-common ChatGPT-account user
    // doesn't see options that error at spawn time.
    {
        id: "gpt-5",
        vendor: "openai",
        pricing: { input: 1.25, output: 10.00, cached_input: 0.125 },
        dropdown: { label: "GPT-5", desc: "Older balanced" },
    },
    {
        id: "gpt-5-mini",
        vendor: "openai",
        pricing: { input: 0.25, output: 2.00, cached_input: 0.025 },
        dropdown: { label: "GPT-5 mini", desc: "Fast / cheap" },
    },
    {
        id: "gpt-5.4",
        vendor: "openai",
        pricing: { input: 2.50, output: 15.00, cached_input: 0.25 },
        dropdown: { label: "GPT-5.4", desc: "Capable" },
        codexCliSupported: true,
    },
    {
        id: "gpt-5.4-mini",
        vendor: "openai",
        pricing: { input: 0.75, output: 4.50, cached_input: 0.075 },
        dropdown: { label: "GPT-5.4 mini", desc: "Balanced (default)" },
        isDefault: true,
        codexCliSupported: true,
    },
    {
        id: "gpt-5.5",
        vendor: "openai",
        pricing: { input: 5.00, output: 30.00, cached_input: 0.50 },
        dropdown: { label: "GPT-5.5", desc: "Balanced" },
        codexCliSupported: true,
    },
    // GPT-5.6 family (GA 2026-07-09). Three variants — Sol / Terra / Luna.
    //
    // SOL IS DELIBERATELY ABSENT. `gpt-5.6-sol` and its `gpt-5.6` alias return
    // NO completion on a probe while the in-registry `gpt-5.5` control returns
    // one from the same CLI — so the probe path is healthy and Sol simply is
    // not reachable. Listing it would put a model in the dropdown that silently
    // produces nothing. Add it only when a probe returns a real completion.
    //
    // Pricing is OpenAI's SHORT-CONTEXT tier. GPT-5.6 prices by context length
    // (long-context roughly doubles input), and this registry has one flat rate
    // per model — so long-context turns under-report cost. Same simplification
    // already applied to every other entry here; a context-aware pricing shape
    // would be a schema change, not a per-model fix.
    {
        // Verified: real completion via codex → "OK"
        id: "gpt-5.6-terra",
        vendor: "openai",
        pricing: { input: 2.00, output: 12.00, cached_input: 0.20 },
        dropdown: { label: "GPT-5.6 Terra", desc: "Balanced, newest" },
        codexCliSupported: true,
    },
    {
        // Verified: real completion via codex → "OK"
        id: "gpt-5.6-luna",
        vendor: "openai",
        pricing: { input: 0.20, output: 1.20, cached_input: 0.02 },
        dropdown: { label: "GPT-5.6 Luna", desc: "Fastest, cheapest" },
        codexCliSupported: true,
    },
    // GPT-4 family (legacy)
    {
        id: "gpt-4o",
        vendor: "openai",
        pricing: { input: 2.50, output: 10.00, cached_input: 1.25 },
        dropdown: { label: "GPT-4o", desc: "Legacy balanced" },
    },
    {
        id: "gpt-4o-mini",
        vendor: "openai",
        pricing: { input: 0.15, output: 0.60, cached_input: 0.075 },
        dropdown: { label: "GPT-4o mini", desc: "Legacy cheap" },
    },
    {
        id: "gpt-4.1",
        vendor: "openai",
        pricing: { input: 2.00, output: 8.00, cached_input: 0.50 },
        dropdown: { label: "GPT-4.1", desc: "Legacy capable" },
    },
    {
        id: "gpt-4.1-mini",
        vendor: "openai",
        pricing: { input: 0.40, output: 1.60, cached_input: 0.10 },
        dropdown: { label: "GPT-4.1 mini", desc: "Legacy cheap" },
    },
    {
        id: "gpt-4.1-nano",
        vendor: "openai",
        pricing: { input: 0.10, output: 0.40, cached_input: 0.025 },
        // API-only model — intentionally no dropdown entry (not user-facing).
    },
    // o-series reasoning
    {
        id: "o3",
        vendor: "openai",
        pricing: { input: 2.00, output: 8.00, cached_input: 0.50 },
        dropdown: { label: "o3", desc: "Deep reasoning" },
    },
    {
        id: "o3-mini",
        vendor: "openai",
        pricing: { input: 1.10, output: 4.40, cached_input: 0.55 },
        dropdown: { label: "o3-mini", desc: "Reasoning" },
    },
    {
        id: "o4-mini",
        vendor: "openai",
        pricing: { input: 1.10, output: 4.40, cached_input: 0.275 },
        dropdown: { label: "o4-mini", desc: "Reasoning (newer)" },
    },
    // ─── Google ───────────────────────────────────────────────────────────
    // Modality-specific pricing (audio inputs cost more on Flash) is
    // approximated at the text/image/video rate. v1.2 design decision —
    // revisit if/when audio inputs route through Gryphon.
    {
        id: "gemini-2.5-flash",
        vendor: "google",
        pricing: { input: 0.30, output: 2.50, cached_input: 0.03 },
        dropdown: { label: "Gemini 2.5 Flash", desc: "Balanced (default)" },
        isDefault: true,
    },
    {
        id: "gemini-2.5-pro",
        vendor: "google",
        pricing: { input: 1.25, output: 10.00, cached_input: 0.125 },
        dropdown: { label: "Gemini 2.5 Pro", desc: "Most capable" },
    },
    {
        id: "gemini-2.5-flash-lite",
        vendor: "google",
        pricing: { input: 0.10, output: 0.40, cached_input: 0.01 },
        dropdown: { label: "Gemini 2.5 Flash-Lite", desc: "Cheap / fast" },
    },
    {
        id: "gemini-3.1-pro-preview",
        vendor: "google",
        pricing: { input: 2.00, output: 12.00, cached_input: 0.20 },
        dropdown: { label: "Gemini 3.1 Pro", desc: "Preview (newest)" },
    },
    {
        id: "gemini-3-flash-preview",
        vendor: "google",
        pricing: { input: 0.50, output: 3.00, cached_input: 0.05 },
        dropdown: { label: "Gemini 3 Flash", desc: "Preview" },
    },
    {
        // Gemini 3.5 Flash — newest GA Flash, tuned for agentic / coding work.
        id: "gemini-3.5-flash",
        vendor: "google",
        pricing: { input: 1.50, output: 9.00, cached_input: 0.15 },
        dropdown: { label: "Gemini 3.5 Flash", desc: "Agentic / coding" },
    },
    {
        // Gemini 3.6 Flash — the newest GA Flash, and cheaper on output than the
        // 3.5 Flash it succeeds ($7.50 vs $9.00) at the same input rate.
        //
        // Verified with a REAL COMPLETION, not the model-probe script: the
        // `gemini` CLI the probe drives is dead on the Code Assist individuals
        // tier and false-negatives everything, so this was probed through the
        // Antigravity CLI instead — `agy --model gemini-3.6-flash --effort low`
        // returned "OK". (`agy` requires a companion --effort for this model.)
        //
        // NOT added alongside it: `gemini-3.5-flash-lite`. Google's docs list it
        // GA, but nothing here can reach it — agy's catalog does not carry it and
        // the gemini CLI is dead — so it stays out until a probe returns a real
        // completion. Adding an unverifiable id is what shipped, and reverted,
        // `gemini-3.5-flash` in the v2.1 → v2.2 window.
        id: "gemini-3.6-flash",
        vendor: "google",
        pricing: { input: 1.50, output: 7.50, cached_input: 0.15 },
        dropdown: { label: "Gemini 3.6 Flash", desc: "Agentic / coding (newest)" },
    },
    {
        // Gemini 3.1 Flash-Lite — cheapest Gemini 3 tier. GA id; supersedes the
        // `gemini-3.1-flash-lite-preview` model (retired 2026-07-09).
        id: "gemini-3.1-flash-lite",
        vendor: "google",
        pricing: { input: 0.25, output: 1.50, cached_input: 0.025 },
        dropdown: { label: "Gemini 3.1 Flash-Lite", desc: "Cheapest Gemini 3" },
    },
];
// Vendor-specific fallback pricing for unknown ids. Kept symmetric to
// the prior per-file `_default` entries so cost estimates over unknown
// models don't regress.
const VENDOR_FALLBACK_PRICING = {
    anthropic: { input: 3.00, output: 15.00 },
    openai: { input: 0.75, output: 4.50, cached_input: 0.075 },
    google: { input: 0.30, output: 2.50, cached_input: 0.03 },
};
// Cross-vendor aliases — Anthropic-style names (haiku/sonnet/opus) map
// to per-vendor counterparts so a user switching Provider keeps a
// working model. `opus` on OpenAI stays at gpt-5.4 (cost-ceiling
// decision); on Anthropic and Google it points at the flagship.
const CROSS_VENDOR_ALIASES = {
    haiku: { anthropic: "claude-haiku-4-5", openai: "gpt-5-mini", google: "gemini-2.5-flash-lite" },
    sonnet: { anthropic: "claude-sonnet-4-6", openai: "gpt-5.4-mini", google: "gemini-2.5-flash" },
    opus: { anthropic: "claude-opus-4-8", openai: "gpt-5.4", google: "gemini-2.5-pro" },
    "opus[1m]": { anthropic: "claude-opus-4-8", openai: "gpt-5.4", google: "gemini-2.5-pro" },
};
// Legacy-alias migration: users whose persisted `settings.model` is one
// of the old aliases get rewritten to the concrete ID at plugin load.
// Keyed by vendor so other vendors can join later if they grow legacy
// aliases (OpenAI and Google have no in-the-wild legacy ids today —
// the omission is intentional, not a TODO).
const LEGACY_ALIAS_MIGRATION = {
    anthropic: {
        "haiku": "claude-haiku-4-5",
        "sonnet": "claude-sonnet-4-6",
        "opus": "claude-opus-4-8",
        "opus[1m]": "claude-opus-4-8",
    },
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
for (const k of Object.keys(VENDOR_FALLBACK_PRICING))
    Object.freeze(VENDOR_FALLBACK_PRICING[k]);
Object.freeze(CROSS_VENDOR_ALIASES);
for (const k of Object.keys(CROSS_VENDOR_ALIASES))
    Object.freeze(CROSS_VENDOR_ALIASES[k]);
Object.freeze(LEGACY_ALIAS_MIGRATION);
for (const k of Object.keys(LEGACY_ALIAS_MIGRATION))
    Object.freeze(LEGACY_ALIAS_MIGRATION[k]);
// ───────────────────────────── lookup API ─────────────────────────────
// Tracks vendors already warned about so each unknown vendor emits at most
// one console.warn per Node process (module-level, survives require cache).
const _warnedUnknownVendors = new Set();
function _warnUnknownVendor(fn, vendor) {
    if (_warnedUnknownVendors.has(vendor))
        return;
    _warnedUnknownVendors.add(vendor);
    console.warn(`[gryphon/registry] ${fn}: unknown vendor "${vendor}" — falling back. Add to registry.js if this is intentional.`);
}
function allModels() {
    return [...MODELS]; // shallow copy of frozen entries; caller can re-order without corrupting registry
}
function modelsByVendor(vendor) {
    return MODELS.filter((m) => m.vendor === vendor);
}
function _findEntry(modelId) {
    return MODELS.find((m) => m.id === modelId);
}
function priceFor(modelId, vendor) {
    const entry = _findEntry(modelId);
    if (entry && entry.pricing)
        return entry.pricing;
    if (VENDOR_FALLBACK_PRICING[vendor])
        return VENDOR_FALLBACK_PRICING[vendor];
    // Unknown vendor: throw rather than silently use OpenAI pricing. The
    // warn-once helper was insufficient — a single warning is easily missed
    // while every subsequent call silently mis-bills.
    throw new Error(`priceFor: unknown vendor "${vendor}". Add to VENDOR_FALLBACK_PRICING in registry.js, ` +
        `or pass a known vendor (anthropic|openai|google).`);
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
function aliasFor(alias, vendor) {
    const crossVendor = CROSS_VENDOR_ALIASES[alias];
    if (crossVendor && crossVendor[vendor])
        return crossVendor[vendor];
    // If alias is already a known id for this vendor, pass through.
    const entry = _findEntry(alias);
    if (entry && entry.vendor === vendor)
        return alias;
    return null;
}
function defaultModelFor(vendor) {
    const entry = modelsByVendor(vendor).find((m) => m.isDefault);
    if (!entry) {
        _warnUnknownVendor("defaultModelFor", vendor);
        return null;
    }
    return entry.id;
}
function dropdownFor(vendor) {
    return modelsByVendor(vendor)
        .filter((m) => m.dropdown)
        .map((m) => ({ id: m.id, label: m.dropdown.label, desc: m.dropdown.desc || "" }));
}
function isKnownModel(modelId) {
    return Boolean(_findEntry(modelId));
}
function contextTokensFor(modelId) {
    const entry = _findEntry(modelId);
    return entry && entry.contextTokens != null ? entry.contextTokens : null;
}
function coldStartMsFor(modelId) {
    const entry = _findEntry(modelId);
    return entry && entry.coldStartMs != null ? entry.coldStartMs : null;
}
function legacyAliasMigrationFor(vendor) {
    return LEGACY_ALIAS_MIGRATION[vendor] || {};
}
function codexCliSupportedModels() {
    return new Set(MODELS.filter((m) => m.vendor === "openai" && m.codexCliSupported).map((m) => m.id));
}
module.exports = {
    // Data tables (exported for tests / advanced consumers)
    MODELS,
    VENDOR_FALLBACK_PRICING,
    CROSS_VENDOR_ALIASES,
    LEGACY_ALIAS_MIGRATION,
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
    codexCliSupportedModels,
};
