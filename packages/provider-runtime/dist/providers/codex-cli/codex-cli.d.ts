/**
 * CodexProvider — implements the LLMProvider contract via the OpenAI
 * `codex` CLI (Codex.app). Each `send()` spawns a fresh `codex exec`
 * (or `codex exec resume <id>`) process, parses its JSONL event stream
 * to EOF, and resolves with the final result.
 *
 * One-shot per turn: unlike claude-code (persistent stdin loop), Codex
 * exec exits after each turn. Resume threads the conversation via
 * `--resume <thread_id>` from the previous turn.
 *
 * Auth: handled by the CLI itself (`codex login`). The provider never
 * touches credentials. If the user isn't logged in, the CLI exits
 * non-zero with an explanatory stderr message which we surface verbatim.
 *
 * Sandbox: Codex's own sandbox handles tool execution (file read/write,
 * shell). We map Gryphon's permissionMode → Codex's sandbox mode rather
 * than wiring Gryphon-side enforcement. This is a documented trade-off:
 * the 27-event hook surface that gives `claude-code` Gryphon's two-axis
 * security has no equivalent here. Users who need Gryphon-enforced
 * protected-pattern rules should choose claude-code or one of the SDK
 * adapters instead.
 *
 * Event stream (JSONL on stdout):
 *   { type: "thread.started", thread_id: "<uuid>" }
 *   { type: "turn.started" }
 *   { type: "item.started",   item: { id, type, ... } }       — tool invocations
 *   { type: "item.completed", item: { id, type, text? } }     — agent_message holds final text
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
 */
declare const DEFAULT_MODEL: any;
declare function _supportsLandlockSandbox(): boolean;
/**
 * Map Gryphon's permissionMode to Codex's --sandbox flag.
 *
 * Now that the HookDispatcher provides real pre-execution interception
 * via Codex's PreToolUse hooks (v1.3 Stage 5), the sandbox mapping is
 * 1-for-1 with Gryphon's modes. Pattern enforcement happens at the
 * hook layer, not at the sandbox layer.
 *
 *   default          → workspace-write (typical agentic editing)
 *   acceptEdits      → workspace-write
 *   plan             → read-only
 *   bypassPermissions→ danger-full-access (explicit YOLO opt-in)
 *
 * Linux landlock fallback (2026-05-04): on Linux kernels <5.13,
 * workspace-write and read-only both fail to initialize ("local
 * command runner failed"). We detect that case and fall through to
 * danger-full-access so the provider is usable. Gryphon's PreToolUse
 * hook still gates every tool call — the sandbox layer was redundant
 * for security per the comment above. The trade-off is the loss of
 * Codex's belt-and-suspenders workspace confinement; acceptable when
 * the alternative is "Codex CLI doesn't work on this host." A
 * one-time console warning surfaces the downgrade for diagnostics.
 */
declare function _mapPermissionToSandbox(permissionMode: any): string;
declare const SESSION_PREFIX = "codex-cli-";
declare function _wrapSession(id: any): string | null;
declare function _unwrapSession(id: any): any;
/**
 * Strip Codex-side internal-mechanism leaks from the model's
 * user-facing text so the chat UI matches Claude Code's clean style.
 *
 * When Gryphon's PreToolUse hook denies a command, Codex returns a
 * tool result like "Command blocked by PreToolUse hook: <reason>" to
 * the model. The model then paraphrases or quotes that verbatim into
 * its assistant message. Users shouldn't see "PreToolUse hook" in
 * the chat — it leaks the implementation detail and contradicts
 * Gryphon's positioning of the protection as "your protected
 * pattern list" (which is what Claude Code's tuned system prompt
 * already enforces).
 *
 * Stripping at the provider boundary is a robust complement to
 * model-prompt instructions: even if the model occasionally lapses
 * and includes the prefix, the user never sees it. The cleaned text
 * still carries the meaningful content (the reason field, the
 * Settings instructions) — only the implementation-detail prefix is
 * removed.
 *
 * Patterns covered: literal prefix at start of text, the same prefix
 * inside a code fence, and the trailing "Command: ..." echo Codex
 * sometimes appends.
 */
declare function _scrubInternalLeaks(text: any): any;
declare class CodexProvider {
    [key: string]: any;
    constructor(codexPath: any, cwd: any, options?: Record<string, any>);
    /**
     * Build the argv for one `codex exec` (or `codex exec resume`) spawn.
     * Each turn rebuilds args from scratch — the process is one-shot, so
     * we don't carry argv state between turns.
     *
     * IMPORTANT: `codex exec resume` accepts a NARROWER flag set than
     * fresh `codex exec`. Sandbox mode, working directory (`-C`), and
     * `--add-dir` are session-scoped and inherited from the original
     * session — passing them on resume causes the CLI to exit with
     * "unexpected argument '--sandbox' found". Fresh-session flags only
     * fire on the initial spawn (when `sessionId` is null).
     */
    _buildArgs(prompt: any): string[];
    send(prompt: any, options: any): any;
    /**
     * Execute one codex exec turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt: any): any;
    _handleStdout(data: any): void;
    _processEvent(raw: any): void;
    /**
     * Stale-session recovery: re-send the most recent prompt as a
     * FRESH Codex session after `codex exec resume <id>` reported "no
     * rollout found". Mirrors ClaudeCodeProvider._handleStaleSession.
     *
     * Why this can happen:
     *   - User cleared their Codex sessions (`codex sessions clear`)
     *     between Gryphon turns
     *   - Codex rotated the rollout file out of its retention window
     *   - The persisted session id came from a corrupt/incomplete
     *     prior turn that never wrote a complete rollout to disk
     *
     * Recovery: kill the failed process, drop the session id (clearing
     * lastSessionId in the host's settings via onSessionExpired callback
     * so the NEXT process construction also doesn't read it back), and
     * re-spawn WITHOUT --resume. The user sees a brief delay; their
     * answer streams in normally.
     *
     * One-shot per provider instance — `_staleRecoveryFired` is set
     * before this runs. If the fresh spawn ALSO fails, the second
     * error surfaces normally.
     */
    _handleStaleSession(): void;
    /**
     * Internal helper: spawn a fresh codex exec (no --resume) for the
     * given prompt. Used only by _handleStaleSession's recovery path.
     * The pending Promise hooks (_currentResolve / _currentReject)
     * MUST already be set to the original send()'s callbacks.
     */
    _respawnFresh(prompt: any): void;
    _handleStderr(data: any): void;
    _handleClose(code: any): void;
    _handleProcessError(err: any): void;
    abort(): void;
    isAlive(): any;
    get costIsEstimate(): boolean;
}
export { CodexProvider, _mapPermissionToSandbox, _supportsLandlockSandbox, _wrapSession, _unwrapSession, _scrubInternalLeaks, SESSION_PREFIX, DEFAULT_MODEL, };
