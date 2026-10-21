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
import type { ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import type { Result, SendOptions, StreamMessageType } from "../../types";
declare const DEFAULT_MODEL: string;
/** Where notices go (Obsidian Notice, console, or a test stub). */
interface HostAdapterLike {
    notify(message: string, opts?: {
        level?: string;
        timeoutMs?: number;
    }): void;
}
/** The slice of the host plugin this provider reads (also handed to the hook dispatcher). */
type GeminiHostPlugin = {
    settings?: {
        googleApiKey?: string;
    } | null;
    consumeTaintedSession?: (sessionId: string) => boolean;
    consumeForceFreshSpawn?: (kind: string) => boolean;
    [key: string]: unknown;
};
/** Test-harness replacement for the real CLI turn. */
type SpawnOverride = (prompt: string) => Promise<Result>;
interface GeminiOptions {
    model?: string | null;
    permissionMode?: string;
    resumeSessionId?: string;
    extraArgs?: string[];
    plugin?: GeminiHostPlugin | null;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride | null;
    [key: string]: unknown;
}
/** Test-harness options-bag constructor form. */
interface GeminiBag {
    geminiPath?: string;
    cwd?: string;
    config?: {
        model?: string;
    } | null;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride;
}
/** What the hook dispatcher hands back for one spawn. */
interface HookExtras {
    ok: boolean;
    mode?: string;
    degradationReason?: string;
    env?: Record<string, string | undefined>;
    args?: string[];
    cleanup?: (() => void) | null;
}
/** `gemini -p` spawns with stdio ["ignore", "pipe", "pipe"]. */
type GeminiProc = ChildProcessByStdio<null, Readable, Readable>;
interface GeminiStats {
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
}
/** One `-o stream-json` stdout event (only the fields read here). */
interface GeminiEvent {
    type?: string;
    session_id?: unknown;
    model?: unknown;
    role?: string;
    content?: unknown;
    delta?: unknown;
    tool_name?: string;
    message?: unknown;
    severity?: string;
    stats?: GeminiStats | null;
}
/**
 * R43-7 review: only hooks that gate EVERY tool call justify yolo. A
 * store-guard FALLBACK (Protected Mode on, full checks down) protects only
 * Gryphon's own settings, so Gemini keeps the user's own approval mode.
 */
declare function _hooksGateTools(hookExtras: HookExtras | null | undefined): boolean;
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
declare function _mapPermissionToApproval(permissionMode: unknown): "default" | "plan" | "auto_edit" | "yolo";
declare const SESSION_PREFIX = "gemini-cli-";
declare const _UNSUPPORTED_CLIENT_MESSAGE: string;
declare function _wrapSession(id: unknown): string | null;
declare function _unwrapSession(id: string | null): string | null;
/**
 * Strip Gemini-side internal-mechanism leaks from the model's
 * user-facing text. Mirrors codex-cli's `_scrubInternalLeaks` —
 * removes any "BeforeTool" / "hook" prefix Gemini might append
 * when reporting a deny, plus the trailing "Command: <echoed
 * shell>" line if it appears. See codex-cli for full rationale.
 */
declare function _scrubInternalLeaks(text: string): string;
declare class GeminiCliProvider {
    geminiPath: string;
    cwd: string;
    options: GeminiOptions;
    _spawnOverride: SpawnOverride | null;
    hostAdapter: HostAdapterLike;
    process: GeminiProc | null;
    alive: boolean;
    sessionId: string | null;
    resolvedModel: string;
    contextTokens: number;
    lastCumulativeCost: number;
    _buffer: string;
    _stderrTail: string;
    _turnText: string;
    _lastStats: GeminiStats | null;
    _currentResolve: ((result: Result) => void) | null;
    _currentReject: ((reason?: unknown) => void) | null;
    _deprecatedClientDetected: boolean;
    onMessage: ((text: string, type: StreamMessageType) => void) | null;
    onError: ((text: string) => void) | null;
    onDone: ((result: Result) => void) | null;
    onSessionExpired: (() => void) | null;
    _failed?: boolean;
    _lastPrompt?: string;
    _staleRecoveryFired?: boolean;
    _hookCleanup?: (() => void) | null;
    constructor(geminiPath: string | GeminiBag, cwd?: string, options?: GeminiOptions);
    _buildArgs(prompt: string, { hooksWired }?: {
        hooksWired?: boolean;
    }): string[];
    _buildEnv(): NodeJS.ProcessEnv;
    send(prompt: string, options?: SendOptions): Promise<Result>;
    /**
     * Execute one gemini -p turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt: string): Promise<Result>;
    _handleStdout(data: Buffer | string): void;
    _processEvent(raw: GeminiEvent | null): void;
    _handleStderr(data: Buffer | string): void;
    _handleClose(code: number | null): void;
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
    _respawnFresh(prompt: string): void;
    _handleProcessError(err: Error): void;
    abort(): void;
    isAlive(): boolean;
    get costIsEstimate(): boolean;
}
export { GeminiCliProvider, _mapPermissionToApproval, _hooksGateTools, _wrapSession, _unwrapSession, _scrubInternalLeaks, SESSION_PREFIX, DEFAULT_MODEL, _UNSUPPORTED_CLIENT_MESSAGE, };
