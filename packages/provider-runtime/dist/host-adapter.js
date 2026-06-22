"use strict";
/**
 * HostAdapter — duck-typed interface for host-environment services
 * that provider-runtime / protect would otherwise hard-code to Obsidian.
 *
 * Required shape (no formal class — just these methods):
 *   notify(message: string, opts?: { level?: "info"|"warn"|"error", timeoutMs?: number }): void
 *     (non-string `message` is coerced via template-literal interpolation)
 *   fetch(url: string, opts?: object): Promise<{ status, text(), json(), ...}>
 *
 * Hosts:
 *   - Obsidian plugin → ObsidianHostAdapter (uses Notice + requestUrl)
 *   - Peitho / headless Node → HeadlessHostAdapter (console.log + globalThis.fetch)
 *   - Tests → any of the above, or a hand-rolled stub
 *
 * Per L1 in docs/consumer-requirements.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeadlessHostAdapter = void 0;
class HeadlessHostAdapter {
    notify(message, opts) {
        opts = opts || {};
        const level = opts.level || "info";
        const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        fn(`[gryphon] ${message}`);
    }
    async fetch(url, opts) {
        opts = opts || {};
        // eslint-disable-next-line obsidianmd/no-global-this -- HeadlessHostAdapter runs in a Node subprocess (hooks/IPC); no window/activeWindow exists there, so globalThis.fetch is the correct global.
        return globalThis.fetch(url, opts);
    }
}
exports.HeadlessHostAdapter = HeadlessHostAdapter;
