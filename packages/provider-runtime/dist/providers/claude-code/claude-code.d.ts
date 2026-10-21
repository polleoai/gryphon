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
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { ClaudeCodeScopeOptions, McpApprovalsReader, ResolvedScope } from "./scope";
import type { Result, SendOptions, StreamMessageType } from "../../types";
/** Where notices go (Obsidian Notice, console, or a test stub). */
interface HostAdapterLike {
    notify(message: string, opts?: {
        level?: string;
        timeoutMs?: number;
    }): void;
    /** Optional (issue #25): the host's own UX for unapproved vault MCP servers. */
    mcpApprovalsPending?: (info: {
        cwd: string;
        vaultKey: string;
        pending: ResolvedScope["pendingApprovals"];
    }) => void;
}
/** The slice of the host plugin this provider reads. */
interface ClaudeCodeHostPlugin {
    ipcServer?: {
        isListening(): boolean;
        socketPath(): string;
    } | null;
    absolutePluginDir?: () => string;
    settings?: {
        devCliDebug?: boolean;
    } | null;
}
/** Test-harness replacement for the real CLI turn. */
type SpawnOverride = (prompt: string) => Promise<Result>;
interface ClaudeCodeOptions {
    model?: string | null;
    effort?: string;
    permissionMode?: string;
    resumeSessionId?: string;
    claudeCodeScope?: ClaudeCodeScopeOptions | null;
    extraArgs?: string[];
    compactionSummary?: unknown;
    plugin?: ClaudeCodeHostPlugin | null;
    security?: unknown;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride | null;
    _mcpApprovals?: McpApprovalsReader | null;
    _claudeUserConfigFile?: string;
}
/** Test-harness options-bag constructor form. */
interface ClaudeCodeBag {
    claudePath?: string;
    cwd?: string;
    config?: {
        model?: string;
    } | null;
    hostAdapter?: HostAdapterLike;
    _spawnOverride?: SpawnOverride;
}
/** Launch context kept for _handleProcessError diagnostics. */
interface SpawnDiagnostic {
    windowsWrapped: boolean;
    argCount: number;
    firstFive: string[];
    lastFive: string[];
    resumeSessionId: string | null;
    hookSettingsFile: string | null;
}
/** A content block inside an `assistant` stream-json event. */
interface CcContentBlock {
    type?: string;
    text?: string;
    name: string;
    thinking?: unknown;
}
/** One parsed stream-json stdout event (only the fields read here). */
interface CcStreamEvent {
    type?: string;
    subtype?: string;
    /** Present on `system` init and `result` events. */
    session_id: string;
    model?: string;
    mcp_servers?: unknown;
    event?: {
        type?: string;
        index?: unknown;
        content_block?: {
            type?: string;
        };
        delta?: {
            type?: string;
            text?: string;
            thinking?: unknown;
        };
    };
    message?: {
        content?: CcContentBlock[];
        usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        };
    };
    name?: string;
    total_cost_usd?: number;
    result?: string;
    /** Present on `result` events. */
    duration_ms: number;
}
declare class ClaudeCodeProvider {
    claudePath: string;
    cwd: string;
    options: ClaudeCodeOptions;
    _spawnOverride: SpawnOverride | null;
    hostAdapter: HostAdapterLike;
    process: ChildProcessWithoutNullStreams | null;
    alive: boolean;
    sessionId: string | null;
    resolvedModel: string | null;
    buffer: string;
    lastCumulativeCost: number;
    contextTokens: number;
    turnText: string;
    turnThinking: string[];
    _thinkingByIndex: Record<string, string>;
    pendingResolve: ((result: Result) => void) | null;
    pendingReject: ((reason?: unknown) => void) | null;
    _stderrTail: string;
    _lastSpawnError: Error | null;
    onMessage: ((text: string, type: StreamMessageType) => void) | null;
    onError: ((text: string) => void) | null;
    onDone: ((result: Result) => void) | null;
    onSessionExpired?: () => void;
    _hookSettingsFile?: string | null;
    _mcpConfigFile?: string | null;
    _memoryFile?: string | null;
    _scopeMcpServerNames?: string[];
    _mcpInitChecked?: boolean;
    _lastSpawnDiagnostic?: SpawnDiagnostic;
    _lastPrompt?: string;
    _staleRecoveryFired?: boolean;
    constructor(claudePath: string | ClaudeCodeBag, cwd?: string, options?: ClaudeCodeOptions);
    spawn(): void;
    send(prompt: string, options?: SendOptions): Promise<Result>;
    /**
     * Execute one prompt turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens, thinking?}.
     *
     * When _spawnOverride is set (test-harness injection), delegates directly
     * to the override function. Otherwise runs the real persistent-process
     * stdin write → stream-json event → result pipeline.
     */
    _doOneTurn(prompt: string): Promise<Result>;
    _writePrompt(prompt: string, onWriteError: ((err: unknown) => void) | null): void;
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
    _handleStdout(data: Buffer | string): void;
    _processEvent(raw: CcStreamEvent): void;
    /**
     * Issue #25 (Design rev 2): the vault defines MCP servers nothing outside
     * the vault has approved, so they were left out of this launch. The host
     * owns the UX (a Notice with a Review action → approval modal) via the
     * optional `hostAdapter.mcpApprovalsPending`; a host without it still gets
     * a plain Notice, so a server never goes missing silently.
     */
    _reportPendingMcpApprovals(scope: ResolvedScope): void;
    /**
     * Issue #25: tell the user when a server on Gryphon's MCP allowlist didn't
     * come up (e.g. the vault's `python3 -m <server>` errors at launch) — the
     * realistic way a consumer's tools go missing. Only our allowlist is
     * checked: under "inherit" the user's own servers are their business.
     * Once per spawn; "pending" is still connecting, not a failure.
     */
    _checkScopedMcpServers(servers: unknown): void;
    _handleStderr(data: Buffer | string): void;
    _handleClose(code: number | null): void;
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
    _formatCloseError(code: number | null): string;
    /**
     * Replace paths / API-key fragments / vault root in stderr text
     * before it's surfaced to the user in an error message. Targets
     * the common bug-report flow where users screenshot the chat
     * panel; the error line shouldn't expose their username, home
     * directory, or any provider-key fragment that CC may have echoed.
     */
    _redactStderrForDisplay(text: string): string;
    _handleProcessError(err: NodeJS.ErrnoException): void;
    /**
     * Remove the per-spawn temp files (--settings and, issue #25,
     * --mcp-config). Best-effort: neither auto-loads anywhere (CC only sees
     * them when we pass the flags explicitly), both are owner-only (0600) —
     * the MCP file can carry server env such as tokens — and the onload
     * orphan sweeper reaps stragglers, so a failed unlink is logged and
     * swallowed.
     */
    _cleanupSpawnFiles(): void;
    abort(): void;
    isAlive(): boolean;
    get costIsEstimate(): boolean;
}
export { ClaudeCodeProvider };
