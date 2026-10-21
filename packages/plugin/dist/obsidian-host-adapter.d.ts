/**
 * ObsidianHostAdapter — wraps Obsidian's Notice + requestUrl behind
 * the HostAdapter duck-type so runtime/protect can stay headless.
 *
 * The plugin instantiates one and passes it to createProvider() and
 * createProtectionContext() so internals never `require("obsidian")` directly.
 */
interface HostAdapterHooks {
    onMcpApprovalsPending?: (report: unknown) => void;
}
interface NotifyOpts {
    level?: string;
    timeoutMs?: number;
}
interface FetchOpts {
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
}
declare class ObsidianHostAdapter {
    mcpApprovalsPending?: (report: unknown) => void;
    /**
     * @param {object} [hooks]
     * @param {Function} [hooks.onMcpApprovalsPending] — issue #25 rev 2: the
     *   claude-code provider left out vault MCP servers nobody approved; the
     *   plugin shows the Notice + review modal (see mcp-approval-ui.ts).
     */
    constructor(hooks?: HostAdapterHooks);
    notify(message: string, opts?: NotifyOpts): void;
    fetch(url: string, opts?: FetchOpts): Promise<{
        status: number;
        text: () => Promise<string>;
        json: () => Promise<unknown>;
    }>;
}
export { ObsidianHostAdapter };
