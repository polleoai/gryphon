/**
 * A small fetch for headless hosts, on node's own http/https/zlib.
 *
 * HeadlessHostAdapter needs a default fetch. The global `fetch` is off-limits
 * in this codebase (Obsidian's review rules — plugin code must use requestUrl),
 * and loading the undici package instead both bundles ~570 KB into the plugin
 * and replaces the process-wide fetch dispatcher (an embedder's proxy setup
 * would silently stop applying). This covers what the adapter's callers use:
 * method / headers / body, fetch's redirect handling, gzip / deflate / br,
 * and a `{ status, headers, text(), json() }` response.
 */
export interface NodeFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    /** Largest decoded body accepted; past it the request is aborted. */
    maxBytes?: number;
    /** Socket idle time before the request is aborted (default 300 s, undici's default). */
    timeoutMs?: number;
    /**
     * SSRF guard: return true for a hostname or IP address that must not be
     * reached. Checked on EVERY hop (the first request and each redirect): the
     * URL's hostname before connecting, and every address DNS resolves it to,
     * at connect time — so the connection uses only checked addresses (no DNS
     * rebinding between the check and the connect).
     */
    blockAddress?: (hostOrIp: string) => boolean;
    /**
     * The http:// proxy URL for one hop's target (credentials allowed), or null
     * to connect directly. Asked again for every redirect hop. With
     * `blockAddress`, the proxy is sent the checked address rather than the
     * name, so it can't resolve the name to somewhere else. See proxyFromEnv().
     */
    proxyFor?: (target: URL) => string | null;
}
export interface NodeFetchResponse {
    status: number;
    /** Lower-cased header names; repeated headers joined with ", ". */
    headers: Record<string, string>;
    text(): Promise<string>;
    json(): Promise<unknown>;
}
/**
 * A `proxyFor` from the usual environment variables, as curl reads them:
 * https targets use https_proxy / HTTPS_PROXY, http targets http_proxy /
 * HTTP_PROXY, either falling back to all_proxy / ALL_PROXY; a value without a
 * scheme means http://. no_proxy / NO_PROXY lists hosts (with optional :port,
 * `.suffix` or `*`) reached directly. Only http:// proxies are supported; an
 * https:// or socks proxy URL makes the request fail with a clear error.
 */
declare function proxyFromEnv(env: Record<string, string | undefined>): (target: URL) => string | null;
declare function nodeFetch(url: string, init?: NodeFetchInit, redirects?: number): Promise<NodeFetchResponse>;
export { nodeFetch, proxyFromEnv };
