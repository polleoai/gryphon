/**
 * Issue #34 regression: detect rate-limit / quota errors across all six
 * provider wire shapes so the chat-view can preserve the user's prompt
 * for retry instead of forcing them to re-type.
 *
 * The classifier must:
 *   - Recognize HTTP 429 (status / statusCode / nested error.status)
 *   - Recognize provider-specific markers (RESOURCE_EXHAUSTED, "Too Many
 *     Requests", "Please retry in", "rate-limit"-shaped strings)
 *   - NOT fire on unrelated errors (network timeout, auth, generic 500)
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { _isRateLimitError, _parseRetryAfterSeconds } = require("../src/chat-view");

// ── positives ────────────────────────────────────────────────────────

test("issue #34: HTTP 429 status (number) is a rate-limit", () => {
  assert.equal(_isRateLimitError({ status: 429, message: "anything" }), true);
});

test("issue #34: HTTP 429 in statusCode (Anthropic SDK shape)", () => {
  assert.equal(_isRateLimitError({ statusCode: 429, message: "x" }), true);
});

test("issue #34: nested error.status === 429 (Google SDK shape)", () => {
  assert.equal(
    _isRateLimitError({ message: "x", error: { status: 429 } }),
    true,
  );
});

test("issue #34: '429' in message body (Gemini CLI stderr passthrough)", () => {
  assert.equal(
    _isRateLimitError(new Error("Got HTTP 429 from upstream")),
    true,
  );
});

test("issue #34: 'Too Many Requests' (OpenAI SDK)", () => {
  assert.equal(_isRateLimitError(new Error("Too Many Requests")), true);
});

test("issue #34: 'rate-limited' / 'rate limited' / 'rate_limit' (broad)", () => {
  assert.equal(_isRateLimitError(new Error("rate-limited this key")), true);
  assert.equal(_isRateLimitError(new Error("rate limited; back off")), true);
  assert.equal(_isRateLimitError(new Error("rate_limit_exceeded")), true);
});

test("issue #34: Gemini RESOURCE_EXHAUSTED (gRPC-style)", () => {
  assert.equal(
    _isRateLimitError(new Error("RESOURCE_EXHAUSTED: quota for free tier")),
    true,
  );
});

test("issue #34: 'Please retry in 27.4s' (Gemini friendly format)", () => {
  assert.equal(
    _isRateLimitError(new Error("Please retry in 27.4s.")),
    true,
  );
});

test("issue #34: 'quota exceeded' / 'quota exhausted'", () => {
  assert.equal(_isRateLimitError(new Error("quota exceeded")), true);
  assert.equal(_isRateLimitError(new Error("quota exhausted today")), true);
});

// ── negatives (must NOT fire) ────────────────────────────────────────

test("issue #34: connection timeout is NOT a rate-limit", () => {
  assert.equal(
    _isRateLimitError(new Error("Connection timed out after 60s")),
    false,
  );
});

test("issue #34: auth error (401/403) is NOT a rate-limit", () => {
  assert.equal(_isRateLimitError({ status: 401, message: "Invalid key" }), false);
  assert.equal(_isRateLimitError({ status: 403, message: "Forbidden" }), false);
});

test("issue #34: generic 500 server error is NOT a rate-limit", () => {
  assert.equal(_isRateLimitError({ status: 500, message: "Server error" }), false);
});

test("issue #34: null / undefined / non-Error inputs are NOT rate-limits", () => {
  assert.equal(_isRateLimitError(null), false);
  assert.equal(_isRateLimitError(undefined), false);
  assert.equal(_isRateLimitError({}), false);
  assert.equal(_isRateLimitError({ message: "" }), false);
});

test("issue #34: a 4290 status in unrelated number doesn't match (word boundary)", () => {
  // 429 must be a word, not a substring like 'error 4290' or '14299'.
  assert.equal(
    _isRateLimitError(new Error("error 4290 unrelated")),
    false,
    "4290 is a different code; must not falsely match 429",
  );
});

// ── #34 deferred: retry-after parsing for auto-retry ─────────────────

test("issue #34 deferred: retry-after from 'Please retry in 12.3s'", () => {
  assert.equal(
    _parseRetryAfterSeconds(new Error("Please retry in 12.3s.")),
    12.3,
  );
});

test("issue #34 deferred: retry-after from milliseconds variant", () => {
  // 500ms → 0.5s — small but >0 and <60, valid.
  assert.equal(
    _parseRetryAfterSeconds(new Error("Please retry in 500ms")),
    0.5,
  );
});

test("issue #34 deferred: Retry-After header (plain object)", () => {
  assert.equal(
    _parseRetryAfterSeconds({
      message: "rate limited",
      headers: { "retry-after": "30" },
    }),
    30,
  );
});

test("issue #34 deferred: Retry-After header (fetch-shape headers.get)", () => {
  const err = {
    message: "rate limited",
    headers: { get: (k) => (k === "retry-after" ? "15" : null) },
  };
  assert.equal(_parseRetryAfterSeconds(err), 15);
});

test("issue #34 deferred: SDK retryAfterSeconds field", () => {
  assert.equal(
    _parseRetryAfterSeconds({ message: "x", retryAfterSeconds: 7 }),
    7,
  );
});

test("issue #34 deferred: caps at 60s (per-day quota returns 86400)", () => {
  // A 24h cooldown is a per-day quota — auto-retry would be a footgun
  // (background tab, accumulated cost, stale prompt). Refuse.
  assert.equal(
    _parseRetryAfterSeconds(new Error("Please retry in 86400s")),
    null,
    "values >60s must return null so the user decides manually",
  );
});

test("issue #34 deferred: zero / negative values return null", () => {
  assert.equal(_parseRetryAfterSeconds({ retryAfterSeconds: 0 }), null);
  assert.equal(_parseRetryAfterSeconds({ retryAfterSeconds: -5 }), null);
});

test("issue #34 deferred: null when error has no retry-after at all", () => {
  assert.equal(
    _parseRetryAfterSeconds(new Error("rate limited (no detail)")),
    null,
    "no parseable delay → caller must NOT auto-retry (avoids tight loops)",
  );
});
