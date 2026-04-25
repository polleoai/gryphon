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
 * SSRF hardening (post-v0.2.0):
 *   - `redirect: "manual"` — we follow redirects ourselves so each hop's
 *     hostname/IP gets re-validated. `fetch`'s default `"follow"` silently
 *     chases a 302 → http://127.0.0.1/admin without any re-check.
 *   - DNS pre-resolution with undici.Agent connect pinning — reject any
 *     hostname that resolves to a private/loopback IP, and pin the TCP
 *     connect to the resolved address so DNS rebinding (TTL=0 attacker
 *     DNS that flips from public to 127.0.0.1 between our check and
 *     undici's own resolution) can't bypass the guard.
 */

const dns = require("dns").promises;
// Use Obsidian's requestUrl. The global `fetch` in the renderer is
// Chromium's browser fetch (CORS-restricted for arbitrary URLs), and
// undici doesn't survive Obsidian's renderer context — its internal
// calls to setTimeout(..).unref() fail because renderer timers are
// browser-style (a number, not a Node Timeout). requestUrl runs in
// Obsidian's main process and bypasses both problems, at the cost of
// losing the undici Agent's connect-pinning SSRF defense. We compensate
// by pre-resolving DNS ourselves and rejecting private addresses before
// the request goes out — the TTL=0 rebinding window remains a known
// gap and is documented as such.
//
// The require is wrapped so that unit tests (which import this file for
// its pure helpers like `_isPrivateHost`) can still load the module in
// a plain Node context where `obsidian` isn't resolvable.
let requestUrl;
try { ({ requestUrl } = require("obsidian")); } catch (_) { /* test context */ }

const SCHEMA = {
  name: "WebFetch",
  description:
    "Fetches content from a URL and returns it as text. HTML is converted " +
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
        description:
          "Optional. What you want to extract from the page. Currently " +
          "returned as-is in the response so you can apply it yourself.",
      },
    },
    required: ["url"],
  },
};

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
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
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
    return _error(
      `Plan mode is active — WebFetch is not permitted. Describe what you ` +
      `would fetch instead, or ask the user to switch to Safe / YOLO mode.`
    );
  }

  // Parse and validate the initial URL.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return _error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return _error(`Only http(s) URLs are supported. Got: ${parsed.protocol}`);
  }
  if (_isPrivateHost(parsed.hostname)) {
    return _error(`Refusing to fetch private/loopback host: ${parsed.hostname}`);
  }

  // DNS pre-resolution SSRF defense: reject if the hostname resolves to
  // any private / loopback / link-local address before we hand the URL
  // to requestUrl. Gap: requestUrl follows redirects internally and we
  // can't re-validate each hop's resolved IP — a post-fetch redirect
  // to http://127.0.0.1 won't be blocked. This is a known limitation;
  // users who fetch attacker-controlled URLs should enable plan mode.
  try {
    await _resolveAndCheck(parsed.hostname);
  } catch (e) {
    return _error(e.message);
  }

  // requestUrl doesn't accept an AbortSignal, so enforce timeout via a
  // Promise.race. The fetch itself runs in Obsidian's main process and
  // will outlive our race if we lose — not a leak in practice because
  // Obsidian tears it down on plugin unload, but worth noting.
  const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(timeoutError), REQUEST_TIMEOUT_MS);
  });

  let response;
  try {
    response = await Promise.race([
      requestUrl({
        url,
        method: "GET",
        headers: BROWSER_HEADERS,
        // throw:false → return even non-2xx responses so we can surface
        // HTTP errors to the model as text instead of exceptions.
        throw: false,
      }),
      timeoutPromise,
    ]);
  } catch (e) {
    if (e === timeoutError) return _error(timeoutError.message);
    return _error(`Fetch failed: ${e.message}`);
  }

  if (response.status < 200 || response.status >= 300) {
    return _error(`HTTP ${response.status} for ${url}`);
  }

  // Headers from requestUrl are a plain object with lowercase keys in
  // Obsidian's implementation (per obsidian-api .d.ts). Normalise
  // defensively in case this changes across Obsidian versions.
  const headers = response.headers || {};
  const contentType = (
    headers["content-type"] ||
    headers["Content-Type"] ||
    ""
  ).toLowerCase();
  if (!_isAllowedContentType(contentType)) {
    return _error(
      `Unsupported content type: ${contentType || "(unknown)"}. ` +
      `WebFetch only handles text-based responses (text/*, application/json, ` +
      `application/xml, application/xhtml+xml). For binaries (PDFs, Office, ` +
      `archives, images, etc.), ask the assistant to use Bash with curl/wget ` +
      `to download the file — you'll approve the exact command before it runs.`
    );
  }

  // requestUrl gives us `.text` directly (already decoded) and `.arrayBuffer`.
  // Prefer `.text` for text content; it handles charset decoding internally.
  let body = typeof response.text === "string" ? response.text : "";
  if (!body && response.arrayBuffer) {
    body = Buffer.from(response.arrayBuffer).toString("utf8");
  }

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

  const header =
    `URL: ${url}\n` +
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
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  if (!addrs || addrs.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  for (const a of addrs) {
    if (_isPrivateHost(a.address)) {
      throw new Error(
        `Refusing to fetch ${hostname} — resolves to private/loopback IP ${a.address}`
      );
    }
  }
  return addrs[0];
}

function _isPrivateHost(hostname) {
  if (!hostname) return true;
  let h = hostname.toLowerCase();
  // IPv6 URLs serialize the hostname as `[::1]` — strip brackets before
  // any comparison, otherwise every string check below silently misses.
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  if (h === "localhost") return true;
  if (h.endsWith(".local")) return true;

  // IPv4 ranges — reject anything that shouldn't leave the machine or the LAN:
  //   127/8      loopback
  //   10/8       RFC1918 private
  //   192.168/16 RFC1918 private
  //   172.16-31/12 RFC1918 private
  //   169.254/16 link-local (incl. AWS/GCP metadata 169.254.169.254)
  //   0/8        "this network" / wildcard bind
  //   100.64/10  RFC6598 CGNAT (shared address space)
  //   224/4      multicast (224.0.0.0 – 239.255.255.255)
  //   255.255.255.255 limited broadcast
  const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [_, a, b, c, d] = ipv4.map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224 && a <= 239) return true;
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
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
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true;
  // fec0::/10 site-local — first 10 bits 1111 1110 11xx → fec..fef
  if (/^fe[cdef]/.test(h)) return true;
  if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h)) return true;
  if (/^ff[0-9a-f]{2}(:|::)/.test(h)) return true;
  if (h.startsWith("::ffff:")) {
    // IPv4-mapped: recurse on the embedded v4 portion.
    const mapped = h.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return _isPrivateHost(mapped);
    return true;  // non-v4 form after ::ffff: is suspicious — fail closed
  }
  // Compact IPv4-compatible (::V4 in any form that ends with the v4):
  //   ::127.0.0.1      explicit
  //   ::7f00:1         hex-packed (7f00:0001 = 127.0.0.1)
  if (h.startsWith("::")) {
    const rest = h.slice(2);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return _isPrivateHost(rest);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return _isPrivateHost(v4);
    }
  }
  // 6to4 — 2002:AABB:CCDD::/48 wraps AA.BB.CC.DD in bytes 2-5. Decode those
  // and recurse. If the embedded v4 is private, traffic to this v6 address
  // ultimately lands on the private v4.
  const sixto4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixto4) {
    const hi = parseInt(sixto4[1], 16);
    const lo = parseInt(sixto4[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (_isPrivateHost(v4)) return true;
  }
  return false;
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
  "text/",                          // text/html, text/plain, text/markdown, text/csv, text/xml, ...
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",         // JS source shown as text (not executed)
  "application/ecmascript",
];

function _isAllowedContentType(contentType) {
  if (!contentType) return false;   // servers that omit Content-Type → refuse (fail closed)
  const ct = contentType.toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix));
}

// Exported for unit tests; the main export remains { SCHEMA, execute }.
module.exports = { SCHEMA, execute, _isPrivateHost, _isAllowedContentType };
