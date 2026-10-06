// TypeScript module marker.

/**
 * HostAdapter — duck-typed interface for host-environment services
 * that provider-runtime / protect would otherwise hard-code to Obsidian.
 *
 * Required shape (no formal class — just these methods):
 *   notify(message: string, opts?: { level?: "info"|"warn"|"error", timeoutMs?: number }): void
 *     (non-string `message` is coerced via template-literal interpolation)
 *   fetch(url: string, opts?: object): Promise<{ status, text(), json(), ...}>
 *
 * Optional:
 *   mcpApprovalsPending({ cwd, vaultKey, pending: [{ name, spec, specHash, reason }] }): void
 *     Issue #25 rev 2 — the claude-code provider left out vault `.mcp.json`
 *     servers no out-of-vault approval matches. Hosts with UI offer review
 *     (approve via @gryphon/protect mcpApprovals); without it the provider
 *     falls back to a plain notify().
 *
 * Hosts:
 *   - Obsidian plugin → ObsidianHostAdapter (uses Notice + requestUrl)
 *   - Peitho / headless Node → HeadlessHostAdapter (console.log + globalThis.fetch)
 *   - Tests → any of the above, or a hand-rolled stub
 *
 * Per L1 in docs/consumer-requirements.md.
 */

class HeadlessHostAdapter {
  notify(message: unknown, opts?: { level?: string; timeoutMs?: number }) {
    opts = opts || {};
    const level = opts.level || "info";
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[gryphon] ${message}`);
  }

  async fetch(url: string, opts?: RequestInit) {
    opts = opts || {};
    // Bare global `fetch` (Node 18+ and the renderer both provide it). This
    // HeadlessHostAdapter runs in a Node subprocess (hooks/IPC) where there is
    // no window/activeWindow, so the obsidianmd window-global guidance doesn't
    // apply. The unqualified call resolves to the global, not this method.
    return fetch(url, opts);
  }
}

module.exports = { HeadlessHostAdapter };
