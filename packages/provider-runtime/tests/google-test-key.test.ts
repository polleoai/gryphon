/**
 * Stage 2 follow-up — Google Gemini test-key validator.
 *
 * The full GoogleProvider lands in Stage 3 (#18). This standalone tiny
 * module backs the Settings tab's "Test key" button so users can verify
 * before Stage 3 ships. Tests cover: empty key, success, invalid key,
 * rate-limit, generic API error, network failure.
 *
 * Task 0.4: testApiKey now accepts a `hostAdapter` parameter. Tests pass
 * a stub adapter directly instead of patching the obsidian module.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { testApiKey } = require("../src/providers/google-api/test-key");

/**
 * Build a stub hostAdapter whose fetch() returns the given response object.
 * Response shape matches Obsidian's requestUrl: { status, json, text, ... }.
 */
function stubAdapter(response) {
  return {
    notify() {},
    fetch: async () => response,
  };
}

function throwingAdapter(err) {
  return {
    notify() {},
    fetch: async () => { throw err; },
  };
}

test("empty/null key returns 'No API key provided' before any request", async () => {
  // No adapter needed — early-return fires before any fetch.
  const a = await testApiKey("");
  const b = await testApiKey(null);
  const c = await testApiKey(undefined);
  for (const r of [a, b, c]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /No API key/i);
  }
});

test("status 200 → ok=true with 'Key works'", async () => {
  const r = await testApiKey("AIza-good", stubAdapter({ status: 200, json: { models: [] } }));
  assert.equal(r.ok, true);
  assert.match(r.message, /works/i);
});

test("status 400 → invalid key", async () => {
  const r = await testApiKey("bad", stubAdapter({
    status: 400,
    json: { error: { message: "API key not valid" } },
  }));
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid API key/i);
});

test("status 401 → invalid key", async () => {
  const r = await testApiKey("bad", stubAdapter({ status: 401, json: {} }));
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid API key/i);
});

test("status 403 → invalid key", async () => {
  const r = await testApiKey("bad", stubAdapter({ status: 403, json: {} }));
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid API key/i);
});

test("status 429 → rate-limited (key may still be valid)", async () => {
  const r = await testApiKey("AIza-throttled", stubAdapter({ status: 429, json: {} }));
  assert.equal(r.ok, false);
  assert.match(r.message, /Rate limited/i);
});

test("other 5xx → generic API error with status code", async () => {
  const r = await testApiKey("AIza", stubAdapter({
    status: 503,
    json: { error: { message: "Service unavailable" } },
  }));
  assert.equal(r.ok, false);
  assert.match(r.message, /503/);
  assert.match(r.message, /Service unavailable/i);
});

test("network failure (thrown error) surfaces underlying message", async () => {
  const r = await testApiKey("AIza", throwingAdapter(new Error("getaddrinfo ENOTFOUND")));
  assert.equal(r.ok, false);
  assert.match(r.message, /ENOTFOUND/);
});

test("URL is constructed against the correct Gemini list-models endpoint", async () => {
  let calledUrl = null;
  const adapter = {
    notify() {},
    fetch: async (url) => {
      calledUrl = url;
      return { status: 200, json: { models: [] } };
    },
  };
  await testApiKey("AIza-test-1234", adapter);
  assert.match(calledUrl, /generativelanguage\.googleapis\.com\/v1beta\/models/);
  assert.match(calledUrl, /key=AIza-test-1234/);
});
