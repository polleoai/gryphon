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
  assert.equal(_isPrivateHost("240.0.0.1"), false);  // class E, above multicast
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
