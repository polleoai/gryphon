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
 *   - headless Node → HeadlessHostAdapter (console.log + globalThis.fetch)
 *   - Tests → any of the above, or a hand-rolled stub
 *
 * Per L1 in docs/consumer-requirements.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeadlessHostAdapter = void 0;
const node_fetch_1 = require("./node-fetch");
class HeadlessHostAdapter {
    _fetchImpl;
    /** `fetchImpl` replaces the default fetch (embedders with their own client, tests). */
    constructor(options = {}) {
        this._fetchImpl = options.fetchImpl || null;
    }
    notify(message, opts) {
        opts = opts || {};
        const level = opts.level || "info";
        // Info goes to console.debug — the same stdout line under node, and
        // Obsidian's quiet-console rule inside the app.
        const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
        fn(`[gryphon] ${message}`);
    }
    async fetch(url, opts) {
        opts = opts || {};
        if (this._fetchImpl)
            return this._fetchImpl(url, opts);
        // node's own http/https (see node-fetch.ts for why not the global fetch).
        return (0, node_fetch_1.nodeFetch)(url, opts);
    }
}
exports.HeadlessHostAdapter = HeadlessHostAdapter;
