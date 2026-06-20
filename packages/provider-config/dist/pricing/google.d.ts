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
export {};
