/**
 * ClaudeCodeProvider — implements the LLMProvider contract via a
 * persistent `claude` CLI child process.
 *
 * Spawns claude with stream-json I/O and parses events (stream_event,
 * assistant, tool_use, result). Exposes message/tool/done callbacks per
 * the contract documented in ../provider-interface.js.
 *
 * Extension point: `options.extraArgs` is appended to the CLI args so
 * callers can supply plugin-specific flags without modifying this module.
 */
declare class ClaudeCodeProvider {
    [key: string]: any;
    constructor(claudePath: any, cwd: any, options?: Record<string, any>);
    spawn(): void;
    send(prompt: any, options: any): any;
    /**
     * Execute one prompt turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens, thinking?}.
     *
     * When _spawnOverride is set (test-harness injection), delegates directly
     * to the override function. Otherwise runs the real persistent-process
     * stdin write → stream-json event → result pipeline.
     */
    _doOneTurn(prompt: any): any;
    _writePrompt(prompt: any, onWriteError: any): void;
    /**
     * CC prints "No conversation found with session ID: <uuid>" to stderr
     * when `--resume` points at a session that's no longer in its local
     * store (jsonl rotated, CC upgraded, user ran `claude --clear-history`,
     * etc.). The process then exits and Gryphon hangs waiting for a result.
     *
     * Recovery: notify the host to clear its stored lastSessionId, kill the
     * dead CC, respawn WITHOUT --resume, re-send the prompt. The user sees
     * a brief pause plus a system message explaining what happened, then
     * their answer streams in normally.
     *
     * The recovery fires at most once per provider instance (`_staleRecoveryFired`),
     * so if the fresh spawn somehow also fails, we surface that error to the
     * user rather than looping.
     */
    _handleStaleSession(): void;
    _handleStdout(data: any): void;
    _processEvent(raw: any): void;
    _handleStderr(data: any): void;
    _handleClose(code: any): void;
    /**
     * Build a user-facing error message for an unexpected CLI exit.
     *
     * CC typically exits 0 with a result event on normal completion. An
     * exit BEFORE a result event means one of:
     *   - An invalid arg (flag parse error, unknown model, bad --settings)
     *   - A runtime crash (uncaught exception, permission problem)
     *   - A hook/IPC chain that ate the turn (rare, but has happened)
     *   - Something matched `--disallowedTools` and CC didn't recover
     *
     * None of these are debuggable from "exit code 1" alone. Including
     * the stderr tail turns the ticket from "unactionable" into "here's
     * the exact error the CLI printed" — the user can match it against
     * their settings or paste it into a bug report.
     */
    _formatCloseError(code: any): string;
    /**
     * Replace paths / API-key fragments / vault root in stderr text
     * before it's surfaced to the user in an error message. Targets
     * the common bug-report flow where users screenshot the chat
     * panel; the error line shouldn't expose their username, home
     * directory, or any provider-key fragment that CC may have echoed.
     */
    _redactStderrForDisplay(text: any): any;
    _handleProcessError(err: any): void;
    /**
     * Remove the per-spawn hook settings file. Best-effort: a leftover
     * file in tmpdir is not a security or correctness issue (the file
     * doesn't auto-load anywhere — CC only sees it when we pass
     * --settings explicitly), so a failed unlink is logged and swallowed.
     */
    _cleanupHookSettingsFile(): void;
    abort(): void;
    isAlive(): any;
    get costIsEstimate(): boolean;
}
export { ClaudeCodeProvider };
