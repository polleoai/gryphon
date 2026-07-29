/**
 * AntigravityCliProvider — implements the LLMProvider contract via the
 * Google Antigravity CLI (`agy`). Each `send()` spawns a fresh
 * `agy -p ... --output-format stream-json --dangerously-skip-permissions`
 * process, parses its JSONL event stream to EOF, and resolves with the
 * final result.
 *
 * Why this provider exists (issue #19): Google cut the `gemini` CLI off
 * the Gemini Code Assist individuals tier (2026-06-18 for Pro/Ultra,
 * 2026-07-27 evidence shows the same shutdown reaching individuals) and
 * is redirecting free-tier users to the Antigravity suite, which ships
 * its own CLI. GeminiCliProvider now detects the resulting
 * `UNSUPPORTED_CLIENT` failure and points users here.
 *
 * One-shot per turn (like CodexProvider/GeminiCliProvider, unlike
 * claude-code's persistent stdin loop).
 *
 * CORRECTION (2026-07-28): the original issue #19 implementation was
 * written without access to a real `agy` binary and assumed its flags
 * and event stream mirrored gemini-cli's. That assumption was WRONG,
 * verified live against a real, authenticated `agy` v1.1.8 install:
 *   - `--yes` and `--no-color` do not exist (`agy --help` lists neither);
 *     passing them exits 2 with usage text on stderr, so every single
 *     call under the old code failed outright.
 *   - `-o` is not a valid short form of `--output-format` (only `-p`,
 *     `-i`, `-c` have short aliases); `-m` is likewise not a valid short
 *     form of `--model`.
 *   - `--resume <id>` does not exist; the real resume flag is
 *     `--conversation <id>`.
 *   - The event stream shape is entirely different from gemini-cli's —
 *     see below. This provider now parses the REAL shape.
 * The wrong flags and wrong event shape are fixed below; behavior,
 * error handling, and the outward send()/cost/session contract are
 * otherwise unchanged.
 *
 * Auth: unlike gemini-cli (API-key-in-env), Antigravity docs describe
 * silent keyring auth on local machines or an OAuth flow for remote/SSH
 * sessions, handled entirely by the CLI itself (mirrors codex-cli's
 * `codex login` model) — Gryphon never touches credentials here. Live
 * testing only exercised an ALREADY-authenticated CLI; the exact
 * unauthenticated-invocation behavior (e.g. whether it prints an OAuth
 * URL and hangs, or fails fast) remains UNVERIFIED against a real run —
 * `_handleStderr`'s auth-missing regex below is still a best-effort
 * guess, not a confirmed error string.
 *
 * Sandbox / approval: no documented per-call approval-mode flag exists
 * for `agy` (unlike gemini's `--approval-mode`), so this provider always
 * passes `--dangerously-skip-permissions` (verified real flag name,
 * confirmed via `init.permission_mode: "always-proceed"` on a live
 * response vs `"request-review"` without it) to auto-approve — the
 * alternative is a headless hang waiting on interactive confirmation.
 * Gryphon's PreToolUse hook IS the enforcement layer here (adapter:
 * `packages/protect/src/hook-adapters/antigravity-cli.ts`). Verified live
 * against agy v1.1.8: a hook `deny` hard-blocks the tool even with
 * `--dangerously-skip-permissions` set, which is what makes auto-approve
 * safe to pass. Note that agy treats a CRASHED hook as allow, so the
 * adapter bakes the hook env into the command rather than relying on spawn
 * inheritance — see its header.
 *
 * Known sharp edges (issue #19, carried into this implementation):
 *   - Headless reliability is not yet solid upstream. A community
 *     wrapper, agy-headless (https://gist.github.com/allahsan/
 *     a9a9e9c8a49aecede67ce974e64ef3cf), works around stdin hangs and
 *     silent stdout/stderr by reading results out of `agy`'s
 *     conversation SQLite store. Upstream antigravity-cli#7
 *     (https://github.com/google-antigravity/antigravity-cli/issues/7)
 *     tracks emitting per-conversation IDs for headless callers.
 *     `--conversation <id>` resume IS confirmed to work against the real
 *     CLI (verified live: a second `-p` call with `--conversation
 *     <conversation_id>` from a prior turn's `result` event continued
 *     the same conversation, with step_index continuing from where the
 *     prior turn left off) — this is no longer speculative.
 *   - `--model` requires a companion `--effort low|medium|high` for SOME
 *     models (verified: Gemini models error `--model ... requires
 *     --effort`) while OTHER models reject `--effort` outright (verified:
 *     Claude models on the same CLI error `--effort is not supported for
 *     model ...`). This is a genuine per-model CLI inconsistency, not
 *     something Gryphon can resolve by guessing — `_buildArgs` below only
 *     adds `--effort` when the caller explicitly supplies
 *     `options.effort` (mirrors claude-code.ts's existing pattern); it
 *     does not inject a default.
 *   - Free-tier quota limits are not published.
 *   - A hard client-side timeout (`_watchdog` below) guards against the
 *     documented stdin-hang failure mode — this provider does NOT rely
 *     solely on the host's outer connection timeout, because that surfaces
 *     a generic "no response" message rather than this provider's
 *     specific, actionable one.
 *
 * Event stream (JSONL on stdout, VERIFIED live against `agy` v1.1.8,
 * authenticated, `--output-format stream-json`). Nothing below is
 * inferred or ported from gemini-cli — every shape was observed from a
 * real invocation:
 *
 *   { event: "init", conversation_id, init: { cwd, tools: [...],
 *     permission_mode: "request-review"|"always-proceed" } }
 *     — first line of every turn. No `model` field is present (unlike
 *     gemini-cli's init event), so this provider cannot learn the
 *     resolved model from the stream; `resolvedModel` stays whatever
 *     `coerceToVendorModel(options.model)` produced at construction.
 *
 *   { event: "step_update", step_update: { conversation_id, step_index,
 *     state: "ACTIVE"|"DONE", step_type, text_delta?, tool_name?,
 *     tool_info?, duration_seconds?, usage? } }
 *     — the bulk of the stream. `step_type` observed values:
 *       - "user_input"     — echo of the prompt; no text, ignored.
 *       - "unknown"        — a fast (~0.5ms) internal bookkeeping step
 *                            with no payload; ignored.
 *       - "agent_response" — carries the assistant's visible text via
 *                            `text_delta`, split across an ACTIVE event
 *                            (partial delta, e.g. "OK") and a DONE event
 *                            for the SAME step_index (the trailing delta,
 *                            e.g. "\n", plus `usage`). Deltas are
 *                            INCREMENTAL — concatenating every
 *                            `text_delta` seen (in arrival order) across
 *                            ALL agent_response step_updates in a turn
 *                            reconstructs the exact final text (confirmed
 *                            byte-for-byte against the terminal `result`
 *                            event's `response` field in every probe run,
 *                            including a multi-step tool-use turn).
 *       - "tool"           — a tool invocation. ACTIVE carries
 *                            `tool_name` + `tool_info.parameters`; DONE
 *                            (same step_index) adds `tool_info.output`.
 *                            No `text_delta`.
 *       - "checkpoint"     — periodic internal step with `usage` but no
 *                            text; ignored.
 *       - "system_message" / "finish" — observed on multi-turn/
 *                            structured-output runs, no payload beyond
 *                            state; ignored.
 *
 *   { event: "result", result: { conversation_id, status: "SUCCESS"|
 *     "ERROR", response, error?, duration_seconds, num_turns, usage:
 *     { input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 *     total_tokens }, structured_output?, json_schema? } }
 *     — always the LAST stdout line. On "SUCCESS", `response` is the
 *     complete final text (authoritative — used to override the
 *     step_update-accumulated text as a belt-and-suspenders check).
 *     On "ERROR" (verified live via an invalid --model probe), `response`
 *     is empty and `error` carries a human-readable message; the process
 *     also exits non-zero (observed: exit 1). Unlike gemini-cli's
 *     `error` event, there is no separate mid-stream error event and no
 *     severity/warning concept — the terminal `result.status` is the
 *     only fatal/non-fatal signal this CLI emits.
 *
 * `usage` field names differ from gemini-cli's `stats`: `cached` becomes
 * `cache_read_tokens`, and `thinking_tokens` is a new field gemini-cli's
 * `stats` shape doesn't have (folded into computeCost's existing
 * candidatesTokenCount mapping below rather than tracked separately,
 * since @gryphon/provider-config's google pricing table has no
 * thinking-token-specific rate).
 */
declare const DEFAULT_MODEL: any;
declare const DEFAULT_HARD_TIMEOUT_MS = 60000;
declare const SESSION_PREFIX = "antigravity-cli-";
declare function _wrapSession(id: any): string | null;
declare function _unwrapSession(id: any): any;
/**
 * Strip Antigravity-side internal-mechanism leaks from the model's
 * user-facing text. Mirrors gemini-cli's `_scrubInternalLeaks` /
 * codex-cli's copy. Load-bearing now that this provider has a real hook
 * adapter: a PreToolUse deny surfaces Gryphon's reason to the model, and
 * without this scrub the model echoes the mechanism vocabulary back to the
 * user (see `feedback_public_release_wording`).
 */
declare function _scrubInternalLeaks(text: any): any;
declare class AntigravityCliProvider {
    [key: string]: any;
    constructor(antigravityPath: any, cwd: any, options?: Record<string, any>);
    _buildArgs(prompt: any): any[];
    _buildEnv(): {
        PATH: any;
    };
    send(prompt: any, options: any): any;
    /**
     * Execute one `agy -p` turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt: any): any;
    _clearWatchdog(): void;
    _handleStdout(data: any): void;
    _processEvent(raw: any): void;
    _handleStderr(data: any): void;
    _handleClose(code: any): void;
    _handleProcessError(err: any): void;
    abort(): void;
    isAlive(): any;
    get costIsEstimate(): boolean;
}
export { AntigravityCliProvider, _wrapSession, _unwrapSession, _scrubInternalLeaks, SESSION_PREFIX, DEFAULT_MODEL, DEFAULT_HARD_TIMEOUT_MS, };
