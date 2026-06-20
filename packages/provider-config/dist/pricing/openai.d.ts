/**
 * OpenAI pricing view — thin derivation over the canonical registry.
 *
 * Public API preserved exactly for back-compat with v1.x callers
 * (provider-runtime's openai-api provider, plugin settings UI).
 *
 * gpt-5.5 long-context multiplier (prompts > 272K input tokens are
 * priced at 2× input / 1.5× output for the full session) is NOT modeled
 * here — see registry.js banner. Flat rate applies for typical <272K
 * prompts.
 *
 * The `cached_input` field is tracked **separately** for telemetry but
 * the v1.2 cost calculator bills cached tokens at the full input rate.
 * Per the design-spec open-question decision, we hold the discount in
 * reserve until OpenAI's public pricing for prompt-cache hits is stable
 * across SKUs. Once formalized, switch the cost calculator to apply the
 * cached_input rate without changing the table shape.
 */
export {};
