declare const MAX_LINE_BYTES: number;
declare const MAX_CONCURRENT_SOCKETS = 32;
declare class PermissionIPCServer {
    _server: import("net").Server | null;
    _socketPath: string | null;
    _handlers: Map<string, (req: Record<string, unknown>) => unknown>;
    _activeSockets: Set<import("net").Socket>;
    _creatingPromise: Promise<void> | null;
    constructor();
    /**
     * Register a handler for a request type. Handler receives the parsed
     * request object and returns (or resolves to) a response object. The
     * server auto-appends a `resp` field (if absent) and echoes back the
     * `id` so the client can correlate.
     */
    on(reqType: string, handler: (req: Record<string, unknown>) => unknown): void;
    /**
     * Bind the socket and start accepting connections. Resolves when the
     * server is listening. Rejects if bind fails.
     *
     * Unlinks any stale socket file from a prior crashed load before
     * binding. On Unix the socket file is chmod'd to 0600 after listen;
     * we also set the process umask during listen as belt-and-suspenders
     * (the initial file perms depend on umask, and different environments
     * have different defaults).
     */
    create(socketPath: string): Promise<void>;
    _doCreate(socketPath: string): Promise<void>;
    /**
     * Stop accepting, tear down active connections, unlink the socket.
     * Safe to call multiple times. Never throws — shutdown failures are
     * logged and swallowed so plugin unload doesn't leave dangling state.
     */
    close(): Promise<void>;
    /** Current socket path (null before create / after close). */
    socketPath(): string | null;
    /** True iff the server is currently bound and accepting connections. */
    isListening(): boolean;
    _onConnection(socket: import("net").Socket): void;
    _handleLine(socket: import("net").Socket, line: string): Promise<void>;
    _safeWrite(socket: import("net").Socket, obj: Record<string, unknown>): void;
}
/**
 * Generate a socket path in the OS temp directory, unique per process.
 * Kept short (tmpdir is always under the 104-char Unix socket limit)
 * and randomised so concurrent plugin loads in separate Obsidian
 * windows don't collide.
 */
declare function defaultSocketPath(): string;
export { PermissionIPCServer, defaultSocketPath, MAX_LINE_BYTES, MAX_CONCURRENT_SOCKETS, };
