/**
 * Antigravity CLI liveness test — spawn a trivial real completion
 * (`<antigravityPath> -p "..." --output-format stream-json
 * --dangerously-skip-permissions`) and assert it returns non-empty
 * assistant text.
 *
 * Issue #19: matches the hardened gemini-cli/codex-cli test-cli.ts —
 * `--version` alone would never catch the class of failure this provider
 * exists to route users away from (an account whose CLI protocol access
 * has been cut off but which still launches fine). Given Antigravity's
 * documented headless sharp edges (stdin hangs, silent stdout/stderr —
 * see antigravity-cli.ts header), a real-prompt liveness probe is even
 * more load-bearing here than for the other two CLIs.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
 *
 * CORRECTION (2026-07-28): flags and event-parsing below were rewritten
 * to match the REAL `agy` v1.1.8 CLI, verified live — see
 * antigravity-cli.ts's header for the full verification writeup. The
 * old `-o stream-json --yes --no-color` argv and gemini-cli-shaped
 * `{ type: "message", ... }` parser never matched anything a real
 * install could produce.
 *
 * Returns { ok, message } with a user-facing message either way.
 */
declare function testCli(antigravityPath: any): Promise<unknown>;
export { testCli };
