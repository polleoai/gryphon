/**
 * F4 (v1.7.0) — Obsidian REST API access policy.
 *
 * Tests the URL matcher and the per-turn counter that drives the
 * one-time "you're enumerating the vault" warning toast.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isObsidianRestApiUrl,
  buildRestApiDenyReason,
  RestApiTurnCounter,
} = require("../src/rest-api-policy");

// ── isObsidianRestApiUrl ──────────────────────────────────────────────

test("isObsidianRestApiUrl matches default HTTPS endpoint on 127.0.0.1", () => {
  assert.equal(isObsidianRestApiUrl("https://127.0.0.1:27124/vault/notes/x.md"), true);
});

test("isObsidianRestApiUrl matches HTTP variant on 27123", () => {
  assert.equal(isObsidianRestApiUrl("http://127.0.0.1:27123/vault/"), true);
});

test("isObsidianRestApiUrl matches localhost hostname", () => {
  assert.equal(isObsidianRestApiUrl("https://localhost:27124/"), true);
});

test("isObsidianRestApiUrl rejects mismatching port", () => {
  // 8080 is a common app port; the REST plugin doesn't use it. Treating
  // it as REST traffic would block legitimate fetches to user-run local
  // services.
  assert.equal(isObsidianRestApiUrl("http://127.0.0.1:8080/vault/"), false);
});

test("isObsidianRestApiUrl rejects non-loopback hosts on the same port", () => {
  // A remote server happens to listen on 27124 — not the local Obsidian
  // REST plugin; this URL must pass through normal SSRF / network policy.
  assert.equal(isObsidianRestApiUrl("https://example.com:27124/vault/"), false);
});

test("isObsidianRestApiUrl rejects non-http(s) schemes", () => {
  assert.equal(isObsidianRestApiUrl("file:///etc/passwd"), false);
  assert.equal(isObsidianRestApiUrl("ws://127.0.0.1:27124/"), false);
});

test("isObsidianRestApiUrl rejects malformed input", () => {
  assert.equal(isObsidianRestApiUrl(""), false);
  assert.equal(isObsidianRestApiUrl(null), false);
  assert.equal(isObsidianRestApiUrl(undefined), false);
  assert.equal(isObsidianRestApiUrl(12345), false);
  assert.equal(isObsidianRestApiUrl("not a url"), false);
});

test("isObsidianRestApiUrl matches case-insensitive hostnames", () => {
  // Browsers / fetch normalize hostnames to lowercase; the LLM may emit
  // mixed case. WHATWG URL parser lowercases automatically — verify.
  assert.equal(isObsidianRestApiUrl("https://LocalHost:27124/"), true);
});

test("isObsidianRestApiUrl handles ::1 (IPv6 loopback)", () => {
  // The WHATWG URL parser bracketizes IPv6 hosts and lowercases the
  // address; both bracket-form and bare-bracket-form should match.
  assert.equal(isObsidianRestApiUrl("http://[::1]:27124/vault/"), true);
});

// ── buildRestApiDenyReason ────────────────────────────────────────────

test("buildRestApiDenyReason names the alternative search path", () => {
  // The reason string is what the model surfaces to the user — it must
  // explicitly point at vault-native search so the model doesn't just
  // try a different REST URL on retry.
  const reason = buildRestApiDenyReason();
  assert.match(reason, /vault-native search|Grep|glob/i);
  assert.match(reason, /REST API/i);
});

// ── RestApiTurnCounter ────────────────────────────────────────────────

test("RestApiTurnCounter starts at zero and counts up", () => {
  const c = new RestApiTurnCounter({ threshold: 5 });
  assert.equal(c.count, 0);
  c.note();
  c.note();
  assert.equal(c.count, 2);
});

test("RestApiTurnCounter fires onWarn once when crossing the threshold", () => {
  let warnCount = 0;
  let lastReported = null;
  const c = new RestApiTurnCounter({
    threshold: 3,
    onWarn: (n) => { warnCount += 1; lastReported = n; },
  });
  c.note(); c.note(); // 2 → no warn
  assert.equal(warnCount, 0);
  c.note(); // 3 → warn fires
  assert.equal(warnCount, 1);
  assert.equal(lastReported, 3);
  c.note(); c.note(); // 4, 5 → no additional warns this turn
  assert.equal(warnCount, 1);
});

test("RestApiTurnCounter reset() clears count and re-arms onWarn", () => {
  let warnCount = 0;
  const c = new RestApiTurnCounter({ threshold: 2, onWarn: () => { warnCount += 1; } });
  c.note(); c.note(); // crosses threshold, warns once
  assert.equal(warnCount, 1);
  c.reset();
  assert.equal(c.count, 0);
  c.note(); c.note(); // new turn — must warn again
  assert.equal(warnCount, 2);
});

test("RestApiTurnCounter swallows callback errors so classify still flows", () => {
  // The IPC classify response must never be blocked by a broken UI
  // callback; the counter swallows the throw on the user's behalf. It
  // also logs to console.error so the regression isn't silent — capture
  // the log to verify the signal is preserved.
  const origErr = console.error;
  let logged = false;
  console.error = (...args) => { if (String(args[0]).includes("onWarn callback")) logged = true; };
  try {
    const c = new RestApiTurnCounter({
      threshold: 1,
      onWarn: () => { throw new Error("ui crashed"); },
    });
    assert.doesNotThrow(() => c.note());
    assert.equal(logged, true, "console.error should fire so the regression is visible");
  } finally {
    console.error = origErr;
  }
});

test("RestApiTurnCounter defaults to threshold 50", () => {
  const c = new RestApiTurnCounter();
  let warned = false;
  c.onWarn = () => { warned = true; };
  for (let i = 0; i < 49; i++) c.note();
  assert.equal(warned, false);
  c.note(); // 50th
  assert.equal(warned, true);
});

test("RestApiTurnCounter handles missing onWarn gracefully", () => {
  const c = new RestApiTurnCounter({ threshold: 1 });
  assert.doesNotThrow(() => c.note());
  assert.equal(c.count, 1);
});
