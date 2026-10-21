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
type CodexHostPlugin = {
    consumeTaintedSession?: (sessionId: string) => boolean;
    consumeForceFreshSpawn?: (kind: string) => boolean;
    [key: string]: unknown;
};
/** Test-harness replacement for the real CLI turn. */
type SpawnOverride = (prompt: string) => Promise<Result>;
interface CodexOptions {
    model?: string | null;
    permissionMode?: string;
    resumeSessionId?: string;
    extraArgs?: string[];
    plugin?: CodexHostPlugin | null;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride | null;
    [key: string]: unknown;
}
/** Test-harness options-bag constructor form. */
interface CodexBag {
    codexPath?: string;
    cwd?: string;
    config?: {
        model?: string;
    } | null;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride;
}
/** `codex exec` spawns with stdio ["ignore", "pipe", "pipe"]. */
type CodexProc = ChildProcessByStdio<null, Readable, Readable>;
interface CodexUsage {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
}
/** One `codex exec --json` stdout event (only the fields read here). */
interface CodexEvent {
    type?: string;
    thread_id?: unknown;
    item?: {
        type?: unknown;
        text?: unknown;
    };
    usage?: CodexUsage | null;
    error?: {
        message?: string;
    } | null;
    message?: string;
}
declare function _supportsLandlockSandbox(): boolean;
/**
 * Hook-adapter args are Codex OPTIONS (e.g. `-c features.hooks=true`, R43-2),
 * so they must precede the `--` that ends options; after it Codex would read
 * them as part of the prompt.
 */
declare function _insertBeforePrompt(args: string[], extra: string[]): void;
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
declare function _mapPermissionToSandbox(permissionMode: unknown): string;
declare const SESSION_PREFIX = "codex-cli-";
declare function _wrapSession(id: unknown): string | null;
declare function _unwrapSession(id: string | null): string | null;
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
declare function _scrubInternalLeaks(text: string): string;
declare class CodexProvider {
    codexPath: string;
    cwd: string;
    options: CodexOptions;
    _spawnOverride: SpawnOverride | null;
    hostAdapter: HostAdapterLike;
    process: CodexProc | null;
    alive: boolean;
    sessionId: string | null;
    resolvedModel: string;
    contextTokens: number;
    lastCumulativeCost: number;
    _buffer: string;
    _stderrTail: string;
    _turnText: string;
    _lastUsage: CodexUsage | null;
    _currentResolve: ((result: Result) => void) | null;
    _currentReject: ((reason?: unknown) => void) | null;
    onMessage: ((text: string, type: StreamMessageType) => void) | null;
    onError: ((text: string) => void) | null;
    onDone: ((result: Result) => void) | null;
    onSessionExpired: (() => void) | null;
    _failed?: boolean;
    _lastPrompt?: string;
    _staleRecoveryFired?: boolean;
    _hookCleanup?: (() => void) | null;
    constructor(codexPath: string | CodexBag, cwd?: string, options?: CodexOptions);
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
    _buildArgs(prompt: string): string[];
    send(prompt: string, options?: SendOptions): Promise<Result>;
    /**
     * Execute one codex exec turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt: string): Promise<Result>;
    _handleStdout(data: Buffer | string): void;
    _processEvent(raw: CodexEvent | null): void;
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
    _respawnFresh(prompt: string): void;
    _handleStderr(data: Buffer | string): void;
    _handleClose(code: number | null): void;
    _handleProcessError(err: Error): void;
    abort(): void;
    isAlive(): boolean;
    get costIsEstimate(): boolean;
}
export { CodexProvider, _mapPermissionToSandbox, _insertBeforePrompt, _supportsLandlockSandbox, _wrapSession, _unwrapSession, _scrubInternalLeaks, SESSION_PREFIX, DEFAULT_MODEL, };
