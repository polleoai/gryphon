/**
 * Codex CLI liveness test — spawn a trivial real completion
 * (`<codexPath> exec --json --skip-git-repo-check --sandbox read-only -C
 * <tmpdir> -- "..."`) and assert it returns non-empty assistant text.
 *
 * Issue #19: `--version` is NOT a liveness check — it only proves the
 * binary launches, not that it can actually serve a completion (e.g. a
 * CLI that launches fine but isn't logged in, or whose account has lost
 * access, still passes `--version`). This test issues a real (billable /
 * quota-consuming) round-trip so the health check actually exercises the
 * failure mode it needs to catch. `--sandbox read-only` and a scratch
 * tmpdir keep the probe side-effect-free.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
 *
 * Returns { ok, message } with a user-facing message either way.
 */
declare function testCli(codexPath: any): Promise<unknown>;
export { testCli };
