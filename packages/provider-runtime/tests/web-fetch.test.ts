/**
 * Unit tests for WebFetch's `_isPrivateHost` guard.
 *
 * This is the single function between a prompt-injected URL/redirect and
 * an internal-network request. The coverage here complements the runtime
 * tests in security-runtime.test.js (which can't exercise non-public DNS
 * without actual network access).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// web-fetch requires `undici`, which is a Node built-in — and requires
// nothing from `obsidian`. Load directly.
const { _isPrivateHost, _isAllowedContentType } = require("../src/providers/anthropic-api/tools/web-fetch");

// ── Public hosts (should be allowed) ────────────────────────────────────

test("public hostnames are allowed", () => {
  assert.equal(_isPrivateHost("example.com"), false);
  assert.equal(_isPrivateHost("api.anthropic.com"), false);
  assert.equal(_isPrivateHost("github.com"), false);
});

test("public IPv4 addresses are allowed", () => {
  assert.equal(_isPrivateHost("8.8.8.8"), false);
  assert.equal(_isPrivateHost("1.1.1.1"), false);
  assert.equal(_isPrivateHost("140.82.121.4"), false);  // github.com
});

test("public IPv6 addresses are allowed", () => {
  assert.equal(_isPrivateHost("2606:2800:220:1:248:1893:25c8:1946"), false);
  assert.equal(_isPrivateHost("2001:4860:4860::8888"), false);
});

// ── IPv4 private / unsafe ranges ────────────────────────────────────────

test("blocks IPv4 loopback 127/8", () => {
  assert.equal(_isPrivateHost("127.0.0.1"), true);
  assert.equal(_isPrivateHost("127.255.255.254"), true);
});

test("blocks IPv4 RFC1918", () => {
  assert.equal(_isPrivateHost("10.0.0.1"), true);
  assert.equal(_isPrivateHost("192.168.1.1"), true);
  assert.equal(_isPrivateHost("172.16.0.1"), true);
  assert.equal(_isPrivateHost("172.31.255.254"), true);
  assert.equal(_isPrivateHost("172.15.0.1"), false);  // just below the range
  assert.equal(_isPrivateHost("172.32.0.1"), false);  // just above the range
});

test("blocks IPv4 link-local 169.254/16 (includes cloud-metadata IP)", () => {
  assert.equal(_isPrivateHost("169.254.169.254"), true);  // AWS/GCP metadata
  assert.equal(_isPrivateHost("169.254.1.1"), true);
});

test("blocks IPv4 wildcard 0/8", () => {
  assert.equal(_isPrivateHost("0.0.0.0"), true);
  assert.equal(_isPrivateHost("0.1.2.3"), true);
});

test("blocks IPv4 CGNAT 100.64/10 (Round 2)", () => {
  assert.equal(_isPrivateHost("100.64.0.1"), true);
  assert.equal(_isPrivateHost("100.127.255.254"), true);
  assert.equal(_isPrivateHost("100.63.0.1"), false);  // below CGNAT
  assert.equal(_isPrivateHost("100.128.0.1"), false);  // above CGNAT
});

test("blocks IPv4 multicast 224/4 (Round 2)", () => {
  assert.equal(_isPrivateHost("224.0.0.1"), true);
  assert.equal(_isPrivateHost("239.255.255.255"), true);
  // 240/4 (class E) is reserved and never publicly routable — blocked too.
  assert.equal(_isPrivateHost("240.0.0.1"), true);
});

test("blocks IPv4 limited broadcast (Round 2)", () => {
  assert.equal(_isPrivateHost("255.255.255.255"), true);
});

// ── IPv6 private / unsafe ranges ────────────────────────────────────────

test("blocks IPv6 loopback and unspecified", () => {
  assert.equal(_isPrivateHost("::1"), true);
  assert.equal(_isPrivateHost("::"), true);
});

test("blocks IPv6 link-local fe80::/10", () => {
  assert.equal(_isPrivateHost("fe80::1"), true);
  assert.equal(_isPrivateHost("fe80:0:0:0:0:0:0:1"), true);
});

test("blocks IPv6 ULA fc00::/7 (Round 2)", () => {
  assert.equal(_isPrivateHost("fc00::1"), true);
  assert.equal(_isPrivateHost("fd12:3456:789a::1"), true);
  // Just outside the ULA range
  assert.equal(_isPrivateHost("fe00::1"), false);
});

test("blocks IPv6 multicast ff00::/8 (Round 2)", () => {
  assert.equal(_isPrivateHost("ff02::1"), true);  // all-nodes
  assert.equal(_isPrivateHost("ff01::1"), true);
  assert.equal(_isPrivateHost("ff00::1"), true);
});

test("blocks IPv4-mapped IPv6 wrapping private IPv4", () => {
  assert.equal(_isPrivateHost("::ffff:127.0.0.1"), true);
  assert.equal(_isPrivateHost("::ffff:10.0.0.1"), true);
  // But a mapped PUBLIC IPv4 is still public
  assert.equal(_isPrivateHost("::ffff:8.8.8.8"), false);
});

// ── DNS names that shouldn't reach the network ──────────────────────────

test("blocks localhost and .local mDNS names", () => {
  assert.equal(_isPrivateHost("localhost"), true);
  assert.equal(_isPrivateHost("LOCALHOST"), true);  // case-insensitive
  assert.equal(_isPrivateHost("my-router.local"), true);
  assert.equal(_isPrivateHost("raspberrypi.local"), true);
});

test("empty or missing hostname is treated as unsafe (fail closed)", () => {
  assert.equal(_isPrivateHost(""), true);
  assert.equal(_isPrivateHost(null), true);
  assert.equal(_isPrivateHost(undefined), true);
});

// ── Round 4 — follow-up IPv6 coverage ──────────────────────────────────

test("blocks IPv6 site-local fec0::/10 (R4-H1)", () => {
  assert.equal(_isPrivateHost("fec0::1"), true);
  assert.equal(_isPrivateHost("fed0::1"), true);
  assert.equal(_isPrivateHost("fee0::1"), true);
  assert.equal(_isPrivateHost("fef0::1"), true);
  // Outside the /10: `feb0::` → first 10 bits 1111 1110 10 — that's
  // link-local's sibling, we don't block it here but it's also not
  // a valid unicast range.
});

test("blocks IPv4-compatible IPv6 ::V4 wrapping private IPv4 (R4-H1)", () => {
  assert.equal(_isPrivateHost("::127.0.0.1"), true);
  assert.equal(_isPrivateHost("::10.0.0.1"), true);
  // Public v4 inside ::V4 is still public
  assert.equal(_isPrivateHost("::8.8.8.8"), false);
});

test("blocks compact IPv4-compat hex form ::7f00:1 (R4-H1)", () => {
  // ::7f00:1 → 0:...:0:7f00:0001 → last 32 bits 7f000001 → 127.0.0.1
  assert.equal(_isPrivateHost("::7f00:1"), true);
  // ::a00:1 → 10.0.0.1
  assert.equal(_isPrivateHost("::a00:1"), true);
  // ::808:808 → 8.8.8.8 (Google DNS, public)
  assert.equal(_isPrivateHost("::808:808"), false);
});

test("blocks 6to4 2002::/16 wrapping private IPv4 (R4-H1)", () => {
  // 2002:AABB:CCDD:: → embeds AA.BB.CC.DD in bytes 2-5.
  //   2002:7f00:0001:: → 127.0.0.1 (loopback)
  assert.equal(_isPrivateHost("2002:7f00:1::"), true);
  //   2002:0a00:0001:: → 10.0.0.1 (RFC1918)
  assert.equal(_isPrivateHost("2002:a00:1::"), true);
  //   2002:0808:0808:: → 8.8.8.8 (public — allowed)
  assert.equal(_isPrivateHost("2002:808:808::"), false);
});

// ── v0.3.3 — strict text-only Content-Type allowlist ───────────────────

test("allows text/* and structured text application types", () => {
  assert.equal(_isAllowedContentType("text/html; charset=utf-8"), true);
  assert.equal(_isAllowedContentType("text/plain"), true);
  assert.equal(_isAllowedContentType("text/markdown"), true);
  assert.equal(_isAllowedContentType("text/csv"), true);
  assert.equal(_isAllowedContentType("text/xml"), true);
  assert.equal(_isAllowedContentType("application/json"), true);
  assert.equal(_isAllowedContentType("application/ld+json"), true);
  assert.equal(_isAllowedContentType("application/xml"), true);
  assert.equal(_isAllowedContentType("application/xhtml+xml"), true);
});

test("rejects binaries and documents", () => {
  assert.equal(_isAllowedContentType("application/pdf"), false);
  assert.equal(_isAllowedContentType("application/msword"), false);
  assert.equal(
    _isAllowedContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    false,
  );
  assert.equal(
    _isAllowedContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    false,
  );
  assert.equal(_isAllowedContentType("application/zip"), false);
  assert.equal(_isAllowedContentType("application/x-tar"), false);
  assert.equal(_isAllowedContentType("application/octet-stream"), false);
  assert.equal(_isAllowedContentType("image/png"), false);
  assert.equal(_isAllowedContentType("image/jpeg"), false);
  assert.equal(_isAllowedContentType("audio/mpeg"), false);
  assert.equal(_isAllowedContentType("video/mp4"), false);
});

test("rejects missing or empty Content-Type (fail closed)", () => {
  assert.equal(_isAllowedContentType(""), false);
  assert.equal(_isAllowedContentType(null), false);
  assert.equal(_isAllowedContentType(undefined), false);
});

test("unwraps IPv6 URL bracket-form [::1] (R4-H2)", () => {
  // URL.hostname for "http://[::1]/" returns "[::1]" with brackets —
  // every downstream check must see the unbracketed form.
  assert.equal(_isPrivateHost("[::1]"), true);
  assert.equal(_isPrivateHost("[fc00::1]"), true);
  assert.equal(_isPrivateHost("[::ffff:127.0.0.1]"), true);
  assert.equal(_isPrivateHost("[2002:7f00:1::]"), true);
  // Public IPv6 stays public after unwrap
  assert.equal(_isPrivateHost("[2606:2800:220:1:248:1893:25c8:1946]"), false);
});

// Headless hosts (HeadlessHostAdapter → nodeFetch) return fetch-style
// text()/json() methods; Obsidian's requestUrl returns properties. WebFetch must
// read the body either way — reading only the property shape made a headless
// fetch "succeed" with an empty page.
test("WebFetch reads a fetch-style (headless) response body, not an empty page", async () => {
  const { execute } = require("../src/providers/anthropic-api/tools/web-fetch");
  const hostAdapter = {
    fetch: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      text: async () => "hello from the page",
      json: async () => { throw new Error("not json"); },
    }),
  };
  const r = await execute({ url: "https://93.184.216.34/" }, { permissionMode: "default", hostAdapter });
  const out = JSON.stringify(r);
  assert.match(out, /hello from the page/);
});

test("WebFetch still reads the requestUrl (Obsidian) property shape", async () => {
  const { execute } = require("../src/providers/anthropic-api/tools/web-fetch");
  const hostAdapter = {
    fetch: async () => ({ status: 200, headers: { "content-type": "text/plain" }, text: "obsidian body" }),
  };
  const r = await execute({ url: "https://93.184.216.34/" }, { permissionMode: "default", hostAdapter });
  assert.match(JSON.stringify(r), /obsidian body/);
});

test("blocks the rest of fe80::/10, NAT64-wrapped private v4, reserved v4 ranges, ::ffff", () => {
  for (const h of ["fe90::1", "feb0::1", "febf::1", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "64:ff9b:1::1",
    "198.18.0.1", "198.19.255.1", "192.0.0.8", "192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "[::ffff]", "::7f"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
  for (const h of ["64:ff9b::808:808", "198.20.0.1", "2606:4700::1111", "8.8.8.8", "fe7f::1"]) {
    assert.equal(_isPrivateHost(h), false, h);
  }
});

test("public hostnames that merely start with fe… are not mistaken for IPv6 link/site-local", () => {
  for (const h of ["feather.com", "febreze.com", "feature.io", "fedex.com", "feedly.com", "fe.example"]) {
    assert.equal(_isPrivateHost(h), false, h);
  }
  for (const h of ["fe80::1", "fe8::1", "febf::1", "fec0::1", "feff::1", "[fe80::1]"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
});

test("WebFetch's DNS pre-check refusal doesn't hand the resolved private address to the model", async () => {
  const { execute } = require("../src/providers/anthropic-api/tools/web-fetch");
  // "localhost." passes the name check; DNS resolves it to loopback.
  let fetched = false;
  const r = await execute({ url: "http://localhost./" }, { permissionMode: "default", hostAdapter: { fetch: async () => { fetched = true; return { status: 200 }; } } });
  const out = JSON.stringify(r);
  assert.match(out, /resolves to a private or loopback address/);
  assert.doesNotMatch(out, /127\.0\.0\.1|::1/);
  assert.equal(fetched, false);
});

test("_isPrivateHost: any IPv6 spelling is canonicalised first (uncompressed, leading zeros, upper case)", () => {
  for (const h of ["0:0:0:0:0:0:0:1", "0000::0001", "[0:0:0:0:0:0:0:1]", "0:0:0:0:0:0:0:0", "FE80:0000::1", "FC00:0:0::1"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
});

test("_isPrivateHost: IPv4 embedded in hex form (canonical text) is decoded, not over-blocked", () => {
  for (const h of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "[::ffff:127.0.0.1]", "64:ff9b::a9fe:a9fe", "::7f00:1"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
  for (const h of ["::ffff:8.8.8.8", "::ffff:808:808", "[::ffff:8.8.8.8]", "64:ff9b::8.8.8.8"]) {
    assert.equal(_isPrivateHost(h), false, h);
  }
});

test("_isPrivateHost: Teredo (2001:0::/32) refused; other 2001: addresses aren't", () => {
  for (const h of ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "2001:0000:1::1"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
  for (const h of ["2001:db8::1", "2001:4860:4860::8888", "2001:1::1"]) {
    assert.equal(_isPrivateHost(h), false, h);
  }
});

test("_isPrivateHost: 6to4 / NAT64 embedded v4 read from all eight groups (zero groups compressed away)", () => {
  for (const h of ["2002:7f00::", "2002:a00::1", "2002:c0a8::1", "2002:a9fe::", "2002:7f00:1::1", "64:ff9b::", "64:ff9b::1", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "64:ff9b:1::", "64:ff9b:1:abcd::1"]) {
    assert.equal(_isPrivateHost(h), true, h);
  }
  for (const h of ["2002:808:808::1", "2002:808:800::", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "2001:db8::1"]) {
    assert.equal(_isPrivateHost(h), false, h);
  }
});
