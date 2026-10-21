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

import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import * as dns from "dns";
import * as net from "net";
import * as tls from "tls";
import type { Transform } from "stream";

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

/** Default cap on a decoded body (a small gzip can expand without bound). */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Socket idle limit; node's http has none, so a silent server would hang the caller. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** fetch's own redirect limit. */
const MAX_REDIRECTS = 20;
/** Credentials fetch drops when a redirect leaves the origin. */
const CROSS_ORIGIN_DROPPED = ["authorization", "cookie", "proxy-authorization"];

function _lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

/** A streaming decoder for the content-encoding, or null for identity. */
function _decoder(encoding: string | undefined): Transform | null {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return zlib.createGunzip();
  if (enc === "br") return zlib.createBrotliDecompress();
  if (enc === "deflate") return zlib.createInflate();
  return null;
}

function _responseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

const BLOCKED_RESOLUTION = (hostname: string) =>
  // The address itself isn't echoed: the error reaches the model.
  new Error(`fetch failed: refusing to connect to ${hostname} — it resolves to a private or loopback address`);

/** One address for `host` that passes `block` (all of them must), for pinning. */
function _checkedAddress(host: string, block: (hostOrIp: string) => boolean): Promise<string> {
  if (net.isIP(host)) return Promise.resolve(host); // literals were checked by the caller
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) { reject(err); return; }
      if (addrs.length === 0) { reject(new Error(`fetch failed: no address for ${host}`)); return; }
      if (addrs.some((a) => block(a.address))) { reject(BLOCKED_RESOLUTION(host)); return; }
      resolve(addrs[0].address);
    });
  });
}

/**
 * A failure reaching the proxy itself (the only TCP connection a proxied
 * request makes), reworded so the proxy's address — usually internal — isn't
 * passed on to the model. Errors after the tunnel (TLS, timeouts) pass through.
 */
function _proxyLegError(e: Error): Error {
  const err = e as NodeJS.ErrnoException;
  if (err.syscall === "connect" || err.syscall === "getaddrinfo") {
    return new Error(`fetch failed: could not reach the configured proxy (${err.code || "connection error"})`);
  }
  return e;
}

/**
 * Opens `target` through an http:// proxy: an absolute-form request for
 * http, a CONNECT tunnel + TLS (certificate checked against the real
 * hostname) for https. Guarded requests name the checked address, never the
 * hostname, so the proxy's own DNS can't send them anywhere else.
 */
async function _requestViaProxy(
  target: URL,
  proxyUrl: string,
  options: http.RequestOptions,
  block: ((hostOrIp: string) => boolean) | undefined,
  timeoutMs: number,
  onResponse: (res: http.IncomingMessage) => void,
): Promise<http.ClientRequest> {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new TypeError("fetch failed: the proxy setting is not a valid URL");
  }
  if (proxy.protocol !== "http:") throw new TypeError(`fetch failed: unsupported proxy protocol ${proxy.protocol}`);
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(proxy.port || 80);
  const proxyAuth: Record<string, string> = {};
  if (proxy.username || proxy.password) {
    const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    proxyAuth["proxy-authorization"] = `Basic ${Buffer.from(creds).toString("base64")}`;
  }
  const bareHost = target.hostname.replace(/^\[|\]$/g, "");
  const address = block ? await _checkedAddress(bareHost, block) : null;
  const hostForProxy = address ? (net.isIPv6(address) ? `[${address}]` : address) : target.hostname;
  const port = target.port || (target.protocol === "https:" ? "443" : "80");

  if (target.protocol === "http:") {
    return http.request({
      host: proxyHost,
      port: proxyPort,
      method: options.method,
      path: `http://${hostForProxy}:${port}${target.pathname}${target.search}`,
      headers: { ...(options.headers as Record<string, string>), host: target.host, ...proxyAuth },
      agent: false,
    }, onResponse);
  }

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const connect = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${hostForProxy}:${port}`,
      headers: { host: `${hostForProxy}:${port}`, ...proxyAuth },
      agent: false,
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Error("fetch failed: the proxy stopped responding (timed out)")));
    connect.on("connect", (res: http.IncomingMessage, sock: net.Socket) => {
      if (res.statusCode === 200) { resolve(sock); return; }
      sock.destroy();
      reject(new Error(`fetch failed: the proxy refused the connection (HTTP ${res.statusCode ?? 0})`));
    });
    connect.on("error", (e: Error) => reject(_proxyLegError(e)));
    connect.end();
  });
  return https.request(target, {
    ...options,
    agent: false,
    // host names what the certificate is checked against (servername, when
    // set, wins); without it an IP-literal target would fall back to the
    // tunnel socket's host — the proxy.
    createConnection: () => tls.connect({ socket, host: bareHost, servername: net.isIP(bareHost) ? undefined : bareHost }),
  }, onResponse);
}

/** Whether `host[:port]` is excluded from proxying by a NO_PROXY value. */
function _noProxyMatches(noProxy: string, host: string, port: string): boolean {
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!m) continue;
    if (m[2] && m[2] !== port) continue;
    const name = m[1].replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/**
 * A `proxyFor` from the usual environment variables, as curl reads them:
 * https targets use https_proxy / HTTPS_PROXY, http targets http_proxy /
 * HTTP_PROXY, either falling back to all_proxy / ALL_PROXY; a value without a
 * scheme means http://. no_proxy / NO_PROXY lists hosts (with optional :port,
 * `.suffix` or `*`) reached directly. Only http:// proxies are supported; an
 * https:// or socks proxy URL makes the request fail with a clear error.
 */
function proxyFromEnv(env: Record<string, string | undefined>): (target: URL) => string | null {
  const pick = (...names: string[]) => {
    for (const n of names) { const v = env[n]; if (v && v.trim()) return v.trim(); }
    return null;
  };
  // curl reads a value with no scheme (proxy.corp:3128) as http://.
  const withScheme = (v: string | null) => (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `http://${v}` : v);
  const httpsProxy = withScheme(pick("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"));
  const httpProxy = withScheme(pick("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"));
  const noProxy = pick("no_proxy", "NO_PROXY") || "";
  return (target: URL) => {
    const proxy = target.protocol === "https:" ? httpsProxy : httpProxy;
    if (!proxy) return null;
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    return _noProxyMatches(noProxy, host, port) ? null : proxy;
  };
}

function nodeFetch(url: string, init: NodeFetchInit = {}, redirects = 0): Promise<NodeFetchResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e instanceof Error ? e : new TypeError(`Invalid URL: ${url}`));
      return;
    }
    const lib = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
    if (!lib) {
      reject(new TypeError(`fetch failed: unsupported protocol ${target.protocol}`));
      return;
    }
    const block = init.blockAddress;
    const bareHost = target.hostname.replace(/^\[|\]$/g, "");
    if (block && (block(target.hostname) || block(bareHost))) {
      reject(new Error(`fetch failed: refusing to connect to ${target.hostname} (private or loopback address)`));
      return;
    }
    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br", ..._lowerHeaders(init.headers) };
    const options: http.RequestOptions = { method, headers };
    // A guarded request never shares the default agent's keep-alive pool: a
    // reused socket skips the lookup below, so an unguarded caller's open
    // connection to an internal host would carry a guarded request there.
    if (block) options.agent = false;
    if (block && !net.isIP(bareHost)) {
      // node skips lookup for IP literals; those were checked above.
      options.lookup = (hostname: string, opts: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void) => {
        dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
          if (err) { cb(err, []); return; }
          if (addrs.length === 0) { cb(new Error(`fetch failed: no address for ${hostname}`), []); return; }
          if (addrs.some((a) => block(a.address))) { cb(BLOCKED_RESOLUTION(hostname), []); return; }
          if (opts.all) cb(null, addrs);
          else cb(null, addrs[0].address, addrs[0].family);
        });
      };
    }
    let req: http.ClientRequest;
    const onResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && status !== 304 && location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new TypeError("fetch failed: redirect count exceeded"));
          return;
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch (e) {
          reject(e instanceof Error ? e : new TypeError(`Invalid redirect location: ${location}`));
          return;
        }
        // fetch: 303 → GET; 301/302 after a POST → GET; 307/308 keep method + body.
        const toGet = status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
        const nextHeaders = { ...headers };
        if (toGet) {
          delete nextHeaders["content-type"];
          delete nextHeaders["content-length"];
        }
        if (next.origin !== target.origin) for (const h of CROSS_ORIGIN_DROPPED) delete nextHeaders[h];
        nodeFetch(next.toString(), {
          method: toGet ? "GET" : method,
          headers: nextHeaders,
          body: toGet ? undefined : init.body,
          maxBytes: init.maxBytes,
          timeoutMs: init.timeoutMs,
          blockAddress: init.blockAddress,
          proxyFor: init.proxyFor,
        }, redirects + 1).then(resolve, reject);
        return;
      }
      const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
      const respond = (text: string) => resolve({
        status,
        headers: _responseHeaders(res.headers),
        text: () => Promise.resolve(text),
        json: () => Promise.resolve().then(() => JSON.parse(text) as unknown),
      });
      // No body by definition: nothing to decode.
      if (method === "HEAD" || status === 204 || status === 304) {
        res.resume();
        res.on("end", () => respond(""));
        return;
      }
      const decoder = _decoder(res.headers["content-encoding"]);
      const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let rawBytes = 0;
      res.on("data", (c: Buffer) => { rawBytes += c.length; });
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        // Stop the decoder too: it would keep inflating what it holds.
        if (decoder) { res.unpipe(decoder); decoder.destroy(); }
        res.destroy();
        req.destroy();
        reject(e);
      };
      res.on("error", fail);
      if (decoder) {
        decoder.on("error", () => {
          // An encoded but empty body (e.g. an empty 200 marked gzip) is empty, not corrupt.
          if (rawBytes === 0 && !settled) { settled = true; respond(""); return; }
          fail(new Error("fetch failed: could not decode the response body"));
        });
      }
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          fail(new Error(`fetch failed: response body larger than ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        respond(Buffer.concat(chunks).toString("utf8"));
      });
    };
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proxy = init.proxyFor ? init.proxyFor(target) : null;
    const send = (r: http.ClientRequest) => {
      req = r;
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("fetch failed: the server stopped responding (timed out)"));
      });
      req.on("error", (e: Error) => reject(proxy ? _proxyLegError(e) : e));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    };
    if (proxy) {
      _requestViaProxy(target, proxy, options, block, timeoutMs, onResponse).then(send, reject);
      return;
    }
    send(lib.request(target, options, onResponse));
  });
}

export { nodeFetch, proxyFromEnv };
