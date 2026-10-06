/**
 * ObsidianHostAdapter — wraps Obsidian's Notice + requestUrl behind
 * the HostAdapter duck-type so runtime/protect can stay headless.
 *
 * The plugin instantiates one and passes it to createProvider() and
 * createProtectionContext() so internals never `require("obsidian")` directly.
 */

class ObsidianHostAdapter {
  declare mcpApprovalsPending?: (report: any) => void;

  /**
   * @param {object} [hooks]
   * @param {Function} [hooks.onMcpApprovalsPending] — issue #25 rev 2: the
   *   claude-code provider left out vault MCP servers nobody approved; the
   *   plugin shows the Notice + review modal (see mcp-approval-ui.ts).
   */
  constructor(hooks?) {
    // Defined only when wired, so the provider's plain-Notice fallback
    // applies to an adapter built without the hook.
    const onPending = hooks && hooks.onMcpApprovalsPending;
    if (typeof onPending === "function") this.mcpApprovalsPending = (report) => onPending(report);
  }

  notify(message, opts) {
    opts = opts || {};
    // opts.level (info|warn|error) is accepted for HostAdapter contract parity but
    // ignored — Obsidian's Notice has no severity surface. Headless paths route by
    // level via console.error/warn/log; here every notice renders identically.
    const { Notice } = require("obsidian");
    new Notice(message, opts.timeoutMs || 5000);
  }

  async fetch(url, opts) {
    opts = opts || {};
    const { requestUrl } = require("obsidian");
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
      json: async () => response.json,
    };
  }
}

module.exports = { ObsidianHostAdapter };
