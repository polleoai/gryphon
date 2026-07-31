/**
 * Claude Code CLI liveness test — spawn a trivial real completion and assert
 * it returns non-empty assistant text.
 *
 * Claude Code was the ONLY CLI provider without one. `scripts/live-cli-probe.sh`
 * reported it as "installed, no live coverage" — meaning the provider Gryphon
 * treats as its primary path was the single one never exercised by the release
 * gate. Same contract as the codex-cli / gemini-cli / antigravity-cli probes:
 * `{ ok, message }`, never throws, bounded.
 *
 * Deliberately uses `--print` with `--output-format stream-json`: a
 * `--version` check would stay green on an account whose CLI launches fine
 * but can no longer complete a turn — exactly the failure mode that made the
 * gemini-cli probe worthless (issue #19).
 *
 * NOTE on `--print`: memory `feedback_avoid_claude_print_flag` warns against
 * `-p`/`--print` for the PROVIDER path (it wants a persistent stream-json
 * session, and per-call `-p` carries cost/behaviour risk across a real
 * conversation). That guidance is about serving turns. This is a one-shot
 * liveness probe with a 6-word prompt, where a stateless single call is the
 * correct shape and a persistent session would be strictly worse.
 */
declare function testCli(claudePath: any): Promise<unknown>;
export { testCli };
