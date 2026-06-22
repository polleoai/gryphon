/**
 * GeminiCliProvider — implements the LLMProvider contract via the
 * Google Gemini CLI (`@google/gemini-cli`). Each `send()` spawns a
 * fresh `gemini -p ... -o stream-json` process, parses its JSONL
 * event stream to EOF, and resolves with the final result.
 *
 * One-shot per turn (like CodexProvider, unlike claude-code's
 * persistent stdin loop). Resume threads the conversation via
 * `--resume <session_id>` from the previous turn.
 *
 * Auth: Gemini CLI requires either GEMINI_API_KEY in env or a
 * settings.json. We pass `settings.googleApiKey` (the same key the
 * google-api SDK provider already uses) into the spawn env as
 * GEMINI_API_KEY. If the key is empty the spawn will exit non-zero
 * with the CLI's own error message, surfaced to chat-view.
 *
 * Sandbox / approval: Gemini CLI has its own approval-mode system
 * (default | auto_edit | yolo | plan). Gryphon's permissionMode is
 * mapped to the closest CLI mode rather than wiring Gryphon-side
 * enforcement — see security trade-off documented in CodexProvider.
 *
 * Event stream (JSONL on stdout):
 *   { type: "init",        timestamp, session_id, model }
 *   { type: "message",     timestamp, role, content, delta? }
 *   { type: "tool_use",    timestamp, tool_name, tool_id, parameters }
 *   { type: "tool_result", timestamp, tool_id, status, output, error? }
 *   { type: "error",       timestamp, severity, message }
 *   { type: "result",      timestamp, status, stats: { input_tokens, output_tokens, total_tokens, cached, duration_ms, ... } }
 */
declare const DEFAULT_MODEL: any;
/**
 * Map Gryphon's permissionMode to Gemini CLI's --approval-mode flag.
 *
 * Now that the HookDispatcher provides real pre-execution interception
 * via Gemini's BeforeTool hook (v1.3 Stage 5), the approval-mode
 * mapping is 1-for-1 with Gryphon's modes. Pattern enforcement
 * happens at the hook layer, not via approval-mode tightening.
 *
 *   default          → "default"   (Gemini prompts before risky tools)
 *   acceptEdits      → "auto_edit" (auto-approve edits, prompt for shell)
 *   plan             → "plan"      (read-only, no side effects)
 *   bypassPermissions→ "yolo"      (auto-approve everything)
 */
declare function _mapPermissionToApproval(permissionMode: any): "default" | "plan" | "auto_edit" | "yolo";
declare const SESSION_PREFIX = "gemini-cli-";
declare function _wrapSession(id: any): string | null;
declare function _unwrapSession(id: any): any;
/**
 * Strip Gemini-side internal-mechanism leaks from the model's
 * user-facing text. Mirrors codex-cli's `_scrubInternalLeaks` —
 * removes any "BeforeTool" / "hook" prefix Gemini might append
 * when reporting a deny, plus the trailing "Command: <echoed
 * shell>" line if it appears. See codex-cli for full rationale.
 */
declare function _scrubInternalLeaks(text: any): any;
declare class GeminiCliProvider {
    [key: string]: any;
    constructor(geminiPath: any, cwd: any, options?: Record<string, any>);
    _buildArgs(prompt: any, { hooksWired }?: {
        hooksWired?: boolean | undefined;
    }): any[];
    _buildEnv(): Record<string, any>;
    send(prompt: any, options: any): any;
    /**
     * Execute one gemini -p turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt: any): any;
    _handleStdout(data: any): void;
    _processEvent(raw: any): void;
    _handleStderr(data: any): void;
    _handleClose(code: any): void;
    /**
     * Stale-session recovery — mirrors CodexProvider._handleStaleSession.
     * Runs when stderr matched `"Error resuming session"` /
     * `"Invalid session identifier"`. Drops the stored session id,
     * notifies the host (chat-view) to clear its persisted
     * lastSessionId, then re-spawns WITHOUT --resume on the same
     * pending Promise so the user sees a brief delay then their
     * answer streams in normally.
     *
     * One-shot per provider instance — `_staleRecoveryFired` is set
     * before this runs. If the fresh spawn ALSO fails, the second
     * error surfaces normally.
     */
    _handleStaleSession(): void;
    /**
     * Re-spawn after a stale-session detection. Mirrors the spawn
     * logic in send() but skips supersede / argument-rebuild details
     * we don't need on the recovery path. The fresh process attaches
     * to the same _currentResolve / _currentReject so completion
     * resolves the original Promise.
     */
    _respawnFresh(prompt: any): void;
    _handleProcessError(err: any): void;
    abort(): void;
    isAlive(): any;
    get costIsEstimate(): boolean;
}
export { GeminiCliProvider, _mapPermissionToApproval, _wrapSession, _unwrapSession, _scrubInternalLeaks, SESSION_PREFIX, DEFAULT_MODEL, };
