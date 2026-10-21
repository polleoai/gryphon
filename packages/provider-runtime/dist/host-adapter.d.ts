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
/** The response surface callers use (nodeFetch and a WHATWG Response both satisfy it). */
interface FetchResponse {
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
}
/** A fetch-like function; the default is nodeFetch (node http/https). */
type FetchImpl = (url: string, opts?: RequestInit) => Promise<FetchResponse>;
declare class HeadlessHostAdapter {
    private readonly _fetchImpl;
    /** `fetchImpl` replaces the default fetch (embedders with their own client, tests). */
    constructor(options?: {
        fetchImpl?: FetchImpl;
    });
    notify(message: unknown, opts?: {
        level?: string;
        timeoutMs?: number;
    }): void;
    fetch(url: string, opts?: RequestInit): Promise<FetchResponse>;
}
export { HeadlessHostAdapter };
