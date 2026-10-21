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

import { nodeFetch } from "./node-fetch";
import type { NodeFetchInit } from "./node-fetch";

/** The response surface callers use (nodeFetch and a WHATWG Response both satisfy it). */
interface FetchResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
/** A fetch-like function; the default is nodeFetch (node http/https). */
type FetchImpl = (url: string, opts?: RequestInit) => Promise<FetchResponse>;

class HeadlessHostAdapter {
  private readonly _fetchImpl: FetchImpl | null;

  /** `fetchImpl` replaces the default fetch (embedders with their own client, tests). */
  constructor(options: { fetchImpl?: FetchImpl } = {}) {
    this._fetchImpl = options.fetchImpl || null;
  }

  notify(message: unknown, opts?: { level?: string; timeoutMs?: number }) {
    opts = opts || {};
    const level = opts.level || "info";
    // Info goes to console.debug — the same stdout line under node, and
    // Obsidian's quiet-console rule inside the app.
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
    fn(`[gryphon] ${message as string}`);
  }

  async fetch(url: string, opts?: RequestInit): Promise<FetchResponse> {
    opts = opts || {};
    if (this._fetchImpl) return this._fetchImpl(url, opts);
    // node's own http/https (see node-fetch.ts for why not the global fetch).
    return nodeFetch(url, opts as NodeFetchInit);
  }
}

export { HeadlessHostAdapter };