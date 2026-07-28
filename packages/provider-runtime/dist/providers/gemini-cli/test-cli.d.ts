/**
 * Gemini CLI liveness test — spawn a trivial real completion
 * (`<geminiPath> -p "..." -o stream-json --skip-trust --approval-mode
 * default`) and assert it returns non-empty assistant text.
 *
 * Issue #19: `--version` is NOT a liveness check — it only proves the
 * binary launches, not that it can actually serve a completion. The
 * 2026-07-27 incident this hardening responds to is exactly this gap:
 * Google cut gemini-cli off the Gemini Code Assist individuals tier, the
 * CLI now exits 0 with empty stdout (reasonCode: 'UNSUPPORTED_CLIENT' on
 * stderr), and `gemini --version` keeps succeeding regardless — so the
 * old smoke test reported healthy while the provider was dead. This test
 * issues a real (billable / quota-consuming) round-trip so the health
 * check actually exercises the failure mode it needs to catch.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
 *
 * Returns { ok, message } with a user-facing message either way.
 */
declare function testCli(geminiPath: any): Promise<unknown>;
export { testCli };
