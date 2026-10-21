"use strict";
/**
 * WebFetch tool — fetch a URL and return its content.
 *
 * Mirrors Claude Code's WebFetch contract. Returns up to MAX_CONTENT_BYTES
 * of decoded body. For HTML, performs minimal cleanup (strip <script>,
 * <style>, collapse whitespace) so the model gets readable text rather
 * than raw markup. PDF / binary content surfaces as an error directing
 * the model to use Read on a local copy if needed.
 *
 * Permission: read-only network operation. Refused only in plan mode;
 * allowed in default / acceptEdits / bypassPermissions without prompt.
 *
 * SSRF hardening:
 *   - The URL's hostname is refused if it is a private / loopback /
 *     link-local literal, or if DNS resolves it to one (checked before the
 *     request).
 *   - The request carries `blockAddress`, and both host adapters send it
 *     through nodeFetch (Obsidian's too: requestUrl would follow redirects
 *     unchecked, #40). Every redirect hop's hostname and every address DNS
 *     resolves it to are checked at connect time, so a redirect to an
 *     internal address and DNS rebinding are both refused; through a proxy,
 *     the proxy is sent the checked address.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA = void 0;
exports.execute = execute;
exports._isPrivateHost = _isPrivateHost;
exports._isAllowedContentType = _isAllowedContentType;
// These run in both the Obsidian renderer and headless Node paths (CLI probes,
// passive backend, hook/IPC subprocess) where `window` is unavailable, so bind
// the ambient timer global to a module-local. obsidianmd/prefer-window-timers
// accepts timer names that resolve to a local binding; window.* would throw in
// the headless paths.
const setTimeoutFn = setTimeout;
const dns_1 = require("dns");
const host_response_1 = require("../../../host-response");
// Network requests are routed through ctx.hostAdapter.fetch(url, opts)
// (supplied at execute() time from the provider that owns the tool loop).
// Because this request sets blockAddress, both ObsidianHostAdapter and
// HeadlessHostAdapter send it through nodeFetch (node http/https), with the
// proxy from HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
//
// Response shape: requestUrl-style properties (text / json / arrayBuffer) or
// fetch-style methods (text() / json()); readText() handles both.
const SCHEMA = {
    name: "WebFetch",
    description: "Fetches content from a URL and returns it as text. HTML is converted " +
        "to readable text. Use this to read documentation, articles, or any " +
        "publicly accessible web page.\n\n" +
        "LIMITATIONS: Sites with strict anti-bot WAFs (Cloudflare managed " +
        "challenge, Imperva, etc.) and login-gated platforms will fail — the " +
        "tool reads the challenge page instead of content. Known-hostile " +
        "domains that almost always fail: x.com, twitter.com, linkedin.com, " +
        "facebook.com, instagram.com, reddit.com, quora.com, and medium.com " +
        "(soft paywalls). When fetching any of those, skip WebFetch and " +
        "use WebSearch instead — it will surface the content via indexed " +
        "third-party sources. For other URLs, try WebFetch first; if it " +
        "returns a challenge page or login redirect, fall back to WebSearch.",
    input_schema: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "The URL to fetch. Must be http(s).",
            },
            prompt: {
                type: "string",
                description: "Optional. What you want to extract from the page. Currently " +
                    "returned as-is in the response so you can apply it yourself.",
            },
        },
        required: ["url"],
    },
};
exports.SCHEMA = SCHEMA;
const MAX_CONTENT_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BROWSER_HEADERS = {
    // Chrome-like UA: many content sites' WAFs (Cloudflare, Akamai,
    // Imperva) block requests with library-ish User-Agents by default,
    // and our original "Gryphon/1.0 (Obsidian plugin)" hit that pattern.
    // User-initiated fetches (the user typed a URL into chat) are
    // legitimate browsing, not anonymous scraping — sending a normal
    // browser UA surfaces that context to the site's WAF correctly.
    // Pinned version so upgrades are deliberate, not automatic.
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
};
async function execute(input, ctx) {
    const url = input.url;
    if (typeof url !== "string" || !url) {
        return _error("Missing required parameter: url");
    }
    // Refuse in plan mode (network IO is observable, even if read-only)
    if (ctx.permissionMode === "plan") {
        return _error(`Plan mode is active — WebFetch is not permitted. Describe what you ` +
            `would fetch instead, or ask the user to switch to Safe / YOLO mode.`);
    }
    // Parse and validate the initial URL.
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return _error(`Invalid URL: ${url}`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return _error(`Only http(s) URLs are supported. Got: ${parsed.protocol}`);
    }
    if (_isPrivateHost(parsed.hostname)) {
        return _error(`Refusing to fetch private/loopback host: ${parsed.hostname}`);
    }
    // Early, friendly refusal when the name resolves to a private address.
    // The binding check is blockAddress below: it re-checks at connect time
    // and on every redirect hop.
    try {
        await _resolveAndCheck(parsed.hostname);
    }
    catch (e) {
        return _error(e.message);
    }
    // The adapters take no AbortSignal, so the overall deadline is a
    // Promise.race; timeoutMs also stops the connection itself going idle
    // past it, so a lost race doesn't leave the socket open.
    const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    const timeoutPromise = new Promise((_, reject) => {
        setTimeoutFn(() => reject(timeoutError), REQUEST_TIMEOUT_MS);
    });
    const hostAdapter = ctx.hostAdapter;
    let response;
    try {
        response = await Promise.race([
            hostAdapter.fetch(url, {
                method: "GET",
                headers: BROWSER_HEADERS,
                // throw:false → return even non-2xx responses so we can surface
                // HTTP errors to the model as text instead of exceptions.
                throw: false,
                timeoutMs: REQUEST_TIMEOUT_MS,
                // Re-check every redirect hop and every resolved address at
                // connect time (both adapters route this through nodeFetch).
                blockAddress: _isPrivateHost,
            }),
            timeoutPromise,
        ]);
    }
    catch (e) {
        if (e === timeoutError)
            return _error(timeoutError.message);
        return _error(`Fetch failed: ${e.message}`);
    }
    if (response.status < 200 || response.status >= 300) {
        return _error(`HTTP ${response.status} for ${url}`);
    }
    // Headers from requestUrl are a plain object with lowercase keys in
    // Obsidian's implementation (per obsidian-api .d.ts). Normalise
    // defensively in case this changes across Obsidian versions.
    const headers = response.headers || {};
    const contentType = (headers["content-type"] ||
        headers["Content-Type"] ||
        "").toLowerCase();
    if (!_isAllowedContentType(contentType)) {
        return _error(`Unsupported content type: ${contentType || "(unknown)"}. ` +
            `WebFetch only handles text-based responses (text/*, application/json, ` +
            `application/xml, application/xhtml+xml). For binaries (PDFs, Office, ` +
            `archives, images, etc.), ask the assistant to use Bash with curl/wget ` +
            `to download the file — you'll approve the exact command before it runs.`);
    }
    // requestUrl's `.text` (already decoded), else fetch-style `.text()`, else
    // `.arrayBuffer` as UTF-8.
    const body = await (0, host_response_1.readText)(response);
    let text = body;
    if (contentType.includes("html")) {
        text = _htmlToText(body);
    }
    // Truncate to keep tool_result blocks within sensible token limits.
    let truncated = false;
    if (Buffer.byteLength(text, "utf8") > MAX_CONTENT_BYTES) {
        text = text.substring(0, MAX_CONTENT_BYTES);
        truncated = true;
    }
    const header = `URL: ${url}\n` +
        `Status: ${response.status}\n` +
        `Content-Type: ${contentType || "(unknown)"}\n` +
        (input.prompt ? `User asked: ${input.prompt}\n` : "") +
        (truncated ? `[truncated to first ${MAX_CONTENT_BYTES} bytes]\n` : "") +
        `---\n`;
    return _ok(header + text);
}
/**
 * Resolve hostname, reject if any address is private/loopback, and
 * return the first address for connect-pinning.
 */
async function _resolveAndCheck(hostname) {
    let addrs;
    try {
        addrs = await dns_1.promises.lookup(hostname, { all: true });
    }
    catch (e) {
        throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
    }
    if (!addrs || addrs.length === 0) {
        throw new Error(`DNS lookup returned no addresses for ${hostname}`);
    }
    for (const a of addrs) {
        if (_isPrivateHost(a.address)) {
            // The address itself isn't echoed: this message reaches the model.
            throw new Error(`Refusing to fetch ${hostname} — it resolves to a private or loopback address`);
        }
    }
    return addrs[0];
}
function _isPrivateHost(hostname) {
    if (!hostname)
        return true;
    let h = hostname.toLowerCase();
    // IPv6 URLs serialize the hostname as `[::1]` — strip brackets before
    // any comparison, otherwise every string check below silently misses.
    if (h.startsWith("[") && h.endsWith("]")) {
        h = h.slice(1, -1);
    }
    // Canonical IPv6 text (lower-case, zeros compressed, leading zeros gone),
    // so 0:0:0:0:0:0:0:1 or 0000::0001 meet the patterns below as ::1. Zone
    // IDs (fe80::1%eth0) can't go in a URL; they keep their text and still
    // match by prefix.
    if (h.includes(":") && !h.includes("%")) {
        try {
            h = new URL(`http://[${h}]/`).hostname.slice(1, -1);
        }
        catch { /* not IPv6: leave as is */ }
    }
    if (h === "localhost")
        return true;
    if (h.endsWith(".local"))
        return true;
    // IPv4 ranges — reject anything that shouldn't leave the machine or the LAN:
    //   127/8      loopback
    //   10/8       RFC1918 private
    //   192.168/16 RFC1918 private
    //   172.16-31/12 RFC1918 private
    //   169.254/16 link-local (incl. AWS/GCP metadata 169.254.169.254)
    //   0/8        "this network" / wildcard bind
    //   100.64/10  RFC6598 CGNAT (shared address space)
    //   224/4      multicast, 240/4 reserved (incl. 255.255.255.255 broadcast)
    //   198.18/15  benchmarking; 192.0.0/24 IETF; TEST-NETs 1–3
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
        const [, a, b, c, d] = ipv4.map(Number);
        if (a === 127 || a === 10 || a === 0)
            return true;
        if (a === 169 && b === 254)
            return true;
        if (a === 192 && b === 168)
            return true;
        if (a === 172 && b >= 16 && b <= 31)
            return true;
        if (a === 100 && b >= 64 && b <= 127)
            return true;
        if (a >= 224)
            return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
        if (a === 198 && (b === 18 || b === 19))
            return true; // 198.18/15 benchmarking
        if (a === 192 && b === 0 && c === 0)
            return true; // 192.0.0/24 IETF protocol assignments
        if (a === 192 && b === 0 && c === 2)
            return true; // 192.0.2/24 TEST-NET-1
        if (a === 198 && b === 51 && c === 100)
            return true; // 198.51.100/24 TEST-NET-2
        if (a === 203 && b === 0 && c === 113)
            return true; // 203.0.113/24 TEST-NET-3
        void d;
    }
    // IPv6 ranges:
    //   ::1             loopback
    //   ::              unspecified / wildcard
    //   fe80::/10       link-local
    //   fec0::/10       site-local (deprecated but still routable on some LANs)
    //   fc00::/7        unique local addresses (ULA — IPv6 equivalent of RFC1918)
    //   ff00::/8        multicast
    //   ::ffff:V4/96    IPv4-mapped (could wrap a private IPv4)
    //   ::V4            IPv4-compatible (deprecated form; also wraps v4)
    //   2002:V4::/16    6to4 tunnel (wraps v4 in the next 32 bits; route to it
    //                    traverses 6to4 relays that land on the embedded v4)
    if (h === "::1" || h === "::")
        return true;
    // The fe..:: prefixes below only apply to IPv6 addresses (which contain
    // ':'); without that guard they'd also match hostnames like feather.com.
    const isV6 = h.includes(":");
    // fe80::/10 link-local — first 10 bits 1111 1110 10xx → fe8..feb
    if (isV6 && /^fe[89ab][0-9a-f]?:/.test(h))
        return true;
    // fec0::/10 site-local — first 10 bits 1111 1110 11xx → fec..fef
    if (isV6 && /^fe[cdef][0-9a-f]?:/.test(h))
        return true;
    if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h))
        return true;
    if (/^ff[0-9a-f]{2}(:|::)/.test(h))
        return true;
    if (h.startsWith("::ffff:")) {
        // IPv4-mapped: recurse on the embedded v4 portion.
        const mapped = h.slice(7);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped))
            return _isPrivateHost(mapped);
        // Canonical text writes the v4 as two hex groups (::ffff:7f00:1).
        const hexMapped = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (hexMapped) {
            const hi = parseInt(hexMapped[1], 16);
            const lo = parseInt(hexMapped[2], 16);
            return _isPrivateHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
        }
        return true; // any other form after ::ffff: is suspicious — fail closed
    }
    // Compact IPv4-compatible (::V4 in any form that ends with the v4):
    //   ::127.0.0.1      explicit
    //   ::7f00:1         hex-packed (7f00:0001 = 127.0.0.1)
    if (h.startsWith("::")) {
        const rest = h.slice(2);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(rest))
            return _isPrivateHost(rest);
        // One group (::ffff, ::7f) embeds 0.0.x.x — in 0/8, never routable.
        if (/^[0-9a-f]{1,4}$/.test(rest))
            return true;
        const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (hex) {
            const hi = parseInt(hex[1], 16);
            const lo = parseInt(hex[2], 16);
            const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
            return _isPrivateHost(v4);
        }
    }
    // NAT64 — 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local-use) embed an
    // IPv4 address that a NAT64 gateway forwards to: treat as private when the
    // embedded v4 is, and the local-use prefix as private outright. 6to4 —
    // 2002:AABB:CCDD::/48 wraps AA.BB.CC.DD; traffic to it lands on that v4.
    // Read from all eight groups: compressed text can drop a zero group
    // (2002:7f00:: embeds 127.0.0.0), so a pattern on the text would miss it.
    const g = _ipv6Groups(h);
    if (g) {
        const v4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
        if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)
            return true;
        if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
            return _isPrivateHost(v4(g[6], g[7]));
        }
        if (g[0] === 0x2002 && _isPrivateHost(v4(g[1], g[2])))
            return true;
    }
    // Teredo — 2001:0::/32 tunnels to an (obfuscated) IPv4 through a relay;
    // not something a web page lives at, so refused outright.
    if (/^2001:(0:|:)/.test(h))
        return true;
    return false;
}
/** The eight 16-bit groups of an IPv6 address (a trailing dotted v4 counts as two), or null. */
function _ipv6Groups(h) {
    let text = h;
    const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) {
        const b = dotted.slice(2).map(Number);
        if (b.some((x) => x > 255))
            return null;
        text = `${dotted[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2)
        return null;
    const part = (x) => (x ? x.split(":") : []);
    const head = part(halves[0]);
    const tail = halves.length === 2 ? part(halves[1]) : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0 || (halves.length === 1 && head.length !== 8))
        return null;
    const groups = [...head, ...Array(fill).fill("0"), ...tail];
    if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x)))
        return null;
    return groups.map((x) => parseInt(x, 16));
}
function _htmlToText(html) {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr|td)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function _ok(text) {
    return { content: [{ type: "text", text }], isError: false };
}
function _error(text) {
    return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
// Strict allowlist — only these media types are delivered to the model.
// Flipping to allowlist (was a reject-list) closes gaps for Office
// formats (docx/xlsx/pptx), archives, and unknown types. Binaries are
// out of scope for WebFetch; the model should use Bash+curl/wget to
// download them, which gives the user a permission modal per command.
const ALLOWED_CONTENT_TYPES = [
    "text/", // text/html, text/plain, text/markdown, text/csv, text/xml, ...
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript", // JS source shown as text (not executed)
    "application/ecmascript",
];
function _isAllowedContentType(contentType) {
    if (!contentType)
        return false; // servers that omit Content-Type → refuse (fail closed)
    const ct = contentType.toLowerCase();
    return ALLOWED_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix));
}
