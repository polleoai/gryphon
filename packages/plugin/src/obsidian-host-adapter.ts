import { Notice, requestUrl } from "obsidian";
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

class ObsidianHostAdapter {
  declare mcpApprovalsPending?: (report: unknown) => void;

  /**
   * @param {object} [hooks]
   * @param {Function} [hooks.onMcpApprovalsPending] — issue #25 rev 2: the
   *   claude-code provider left out vault MCP servers nobody approved; the
   *   plugin shows the Notice + review modal (see mcp-approval-ui.ts).
   */
  constructor(hooks?: HostAdapterHooks) {
    // Defined only when wired, so the provider's plain-Notice fallback
    // applies to an adapter built without the hook.
    const onPending = hooks && hooks.onMcpApprovalsPending;
    if (typeof onPending === "function") this.mcpApprovalsPending = (report: unknown) => onPending(report);
  }

  notify(message: string, opts?: NotifyOpts) {
    opts = opts || {};
    // opts.level (info|warn|error) is accepted for HostAdapter contract parity but
    // ignored — Obsidian's Notice has no severity surface. Headless paths route by
    // level via console.error/warn/log; here every notice renders identically.
    new Notice(message, opts.timeoutMs || 5000);
  }

  async fetch(url: string, opts?: FetchOpts) {
    opts = opts || {};
    const response = await requestUrl({
      url,
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      throw: false,
    });
    // Normalise to a fetch-like shape so callers can write provider-agnostic code.
    return {
      status: response.status,
      text: async () => response.text,
      json: async () => response.json as unknown,
    };
  }
}

export { ObsidianHostAdapter };
