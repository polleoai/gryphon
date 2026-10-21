"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeFetch = nodeFetch;
exports.proxyFromEnv = proxyFromEnv;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const zlib = __importStar(require("zlib"));
const dns = __importStar(require("dns"));
const net = __importStar(require("net"));
const tls = __importStar(require("tls"));
/** Default cap on a decoded body (a small gzip can expand without bound). */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Socket idle limit; node's http has none, so a silent server would hang the caller. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** fetch's own redirect limit. */
const MAX_REDIRECTS = 20;
/** Credentials fetch drops when a redirect leaves the origin. */
const CROSS_ORIGIN_DROPPED = ["authorization", "cookie", "proxy-authorization"];
function _lowerHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {}))
        out[k.toLowerCase()] = v;
    return out;
}
/** A streaming decoder for the content-encoding, or null for identity. */
function _decoder(encoding) {
    const enc = (encoding || "").trim().toLowerCase();
    if (enc === "gzip" || enc === "x-gzip")
        return zlib.createGunzip();
    if (enc === "br")
        return zlib.createBrotliDecompress();
    if (enc === "deflate")
        return zlib.createInflate();
    return null;
}
function _responseHeaders(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === undefined)
            continue;
        out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
}
const BLOCKED_RESOLUTION = (hostname) => 
// The address itself isn't echoed: the error reaches the model.
new Error(`fetch failed: refusing to connect to ${hostname} — it resolves to a private or loopback address`);
/** One address for `host` that passes `block` (all of them must), for pinning. */
function _checkedAddress(host, block) {
    if (net.isIP(host))
        return Promise.resolve(host); // literals were checked by the caller
    return new Promise((resolve, reject) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
            if (err) {
                reject(err);
                return;
            }
            if (addrs.length === 0) {
                reject(new Error(`fetch failed: no address for ${host}`));
                return;
            }
            if (addrs.some((a) => block(a.address))) {
                reject(BLOCKED_RESOLUTION(host));
                return;
            }
            resolve(addrs[0].address);
        });
    });
}
/**
 * A failure reaching the proxy itself (the only TCP connection a proxied
 * request makes), reworded so the proxy's address — usually internal — isn't
 * passed on to the model. Errors after the tunnel (TLS, timeouts) pass through.
 */
function _proxyLegError(e) {
    const err = e;
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
async function _requestViaProxy(target, proxyUrl, options, block, timeoutMs, onResponse) {
    let proxy;
    try {
        proxy = new URL(proxyUrl);
    }
    catch {
        throw new TypeError("fetch failed: the proxy setting is not a valid URL");
    }
    if (proxy.protocol !== "http:")
        throw new TypeError(`fetch failed: unsupported proxy protocol ${proxy.protocol}`);
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
    const proxyPort = Number(proxy.port || 80);
    const proxyAuth = {};
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
            headers: { ...options.headers, host: target.host, ...proxyAuth },
            agent: false,
        }, onResponse);
    }
    const socket = await new Promise((resolve, reject) => {
        const connect = http.request({
            host: proxyHost,
            port: proxyPort,
            method: "CONNECT",
            path: `${hostForProxy}:${port}`,
            headers: { host: `${hostForProxy}:${port}`, ...proxyAuth },
            agent: false,
        });
        connect.setTimeout(timeoutMs, () => connect.destroy(new Error("fetch failed: the proxy stopped responding (timed out)")));
        connect.on("connect", (res, sock) => {
            if (res.statusCode === 200) {
                resolve(sock);
                return;
            }
            sock.destroy();
            reject(new Error(`fetch failed: the proxy refused the connection (HTTP ${res.statusCode ?? 0})`));
        });
        connect.on("error", (e) => reject(_proxyLegError(e)));
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
function _noProxyMatches(noProxy, host, port) {
    for (const raw of noProxy.split(/[\s,]+/)) {
        const entry = raw.trim().toLowerCase();
        if (!entry)
            continue;
        if (entry === "*")
            return true;
        const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
        if (!m)
            continue;
        if (m[2] && m[2] !== port)
            continue;
        const name = m[1].replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
        if (host === name || host.endsWith(`.${name}`))
            return true;
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
function proxyFromEnv(env) {
    const pick = (...names) => {
        for (const n of names) {
            const v = env[n];
            if (v && v.trim())
                return v.trim();
        }
        return null;
    };
    // curl reads a value with no scheme (proxy.corp:3128) as http://.
    const withScheme = (v) => (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `http://${v}` : v);
    const httpsProxy = withScheme(pick("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"));
    const httpProxy = withScheme(pick("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"));
    const noProxy = pick("no_proxy", "NO_PROXY") || "";
    return (target) => {
        const proxy = target.protocol === "https:" ? httpsProxy : httpProxy;
        if (!proxy)
            return null;
        const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        const port = target.port || (target.protocol === "https:" ? "443" : "80");
        return _noProxyMatches(noProxy, host, port) ? null : proxy;
    };
}
function nodeFetch(url, init = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        }
        catch (e) {
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
        const headers = { "accept-encoding": "gzip, deflate, br", ..._lowerHeaders(init.headers) };
        const options = { method, headers };
        // A guarded request never shares the default agent's keep-alive pool: a
        // reused socket skips the lookup below, so an unguarded caller's open
        // connection to an internal host would carry a guarded request there.
        if (block)
            options.agent = false;
        if (block && !net.isIP(bareHost)) {
            // node skips lookup for IP literals; those were checked above.
            options.lookup = (hostname, opts, cb) => {
                dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
                    if (err) {
                        cb(err, []);
                        return;
                    }
                    if (addrs.length === 0) {
                        cb(new Error(`fetch failed: no address for ${hostname}`), []);
                        return;
                    }
                    if (addrs.some((a) => block(a.address))) {
                        cb(BLOCKED_RESOLUTION(hostname), []);
                        return;
                    }
                    if (opts.all)
                        cb(null, addrs);
                    else
                        cb(null, addrs[0].address, addrs[0].family);
                });
            };
        }
        let req;
        const onResponse = (res) => {
            const status = res.statusCode || 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && status !== 304 && location) {
                res.resume();
                if (redirects >= MAX_REDIRECTS) {
                    reject(new TypeError("fetch failed: redirect count exceeded"));
                    return;
                }
                let next;
                try {
                    next = new URL(location, target);
                }
                catch (e) {
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
                if (next.origin !== target.origin)
                    for (const h of CROSS_ORIGIN_DROPPED)
                        delete nextHeaders[h];
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
            const respond = (text) => resolve({
                status,
                headers: _responseHeaders(res.headers),
                text: () => Promise.resolve(text),
                json: () => Promise.resolve().then(() => JSON.parse(text)),
            });
            // No body by definition: nothing to decode.
            if (method === "HEAD" || status === 204 || status === 304) {
                res.resume();
                res.on("end", () => respond(""));
                return;
            }
            const decoder = _decoder(res.headers["content-encoding"]);
            const stream = decoder ? res.pipe(decoder) : res;
            const chunks = [];
            let size = 0;
            let settled = false;
            let rawBytes = 0;
            res.on("data", (c) => { rawBytes += c.length; });
            const fail = (e) => {
                if (settled)
                    return;
                settled = true;
                // Stop the decoder too: it would keep inflating what it holds.
                if (decoder) {
                    res.unpipe(decoder);
                    decoder.destroy();
                }
                res.destroy();
                req.destroy();
                reject(e);
            };
            res.on("error", fail);
            if (decoder) {
                decoder.on("error", () => {
                    // An encoded but empty body (e.g. an empty 200 marked gzip) is empty, not corrupt.
                    if (rawBytes === 0 && !settled) {
                        settled = true;
                        respond("");
                        return;
                    }
                    fail(new Error("fetch failed: could not decode the response body"));
                });
            }
            stream.on("data", (c) => {
                size += c.length;
                if (size > maxBytes) {
                    fail(new Error(`fetch failed: response body larger than ${maxBytes} bytes`));
                    return;
                }
                chunks.push(c);
            });
            stream.on("end", () => {
                if (settled)
                    return;
                settled = true;
                respond(Buffer.concat(chunks).toString("utf8"));
            });
        };
        const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const proxy = init.proxyFor ? init.proxyFor(target) : null;
        const send = (r) => {
            req = r;
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error("fetch failed: the server stopped responding (timed out)"));
            });
            req.on("error", (e) => reject(proxy ? _proxyLegError(e) : e));
            if (init.body !== undefined)
                req.write(init.body);
            req.end();
        };
        if (proxy) {
            _requestViaProxy(target, proxy, options, block, timeoutMs, onResponse).then(send, reject);
            return;
        }
        send(lib.request(target, options, onResponse));
    });
}
