/**
 * Stage 2 follow-up — Google Gemini test-key validator.
 *
 * The full GoogleProvider lands in Stage 3 (#18). This standalone tiny
 * module backs the Settings tab's "Test key" button so users can verify
 * before Stage 3 ships. Tests cover: empty key, success, invalid key,
 * rate-limit, generic API error, network failure.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

// Hijack the obsidian stub's requestUrl to script per-test responses.
const obsidianStub = require(stubPath);
const origRequestUrl = obsidianStub.requestUrl;

function withMockResponse(response, fn) {
  obsidianStub.requestUrl = async () => response;
  return fn().finally(() => { obsidianStub.requestUrl = origRequestUrl; });
}

function withMockError(err, fn) {
  obsidianStub.requestUrl = async () => { throw err; };
  return fn().finally(() => { obsidianStub.requestUrl = origRequestUrl; });
}

const { testApiKey } = require("../src/providers/google-api/test-key");

test("empty/null key returns 'No API key provided' before any request", async () => {
  const a = await testApiKey("");
  const b = await testApiKey(null);
  const c = await testApiKey(undefined);
  for (const r of [a, b, c]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /No API key/i);
  }
});

test("status 200 → ok=true with 'Key works'", async () => {
  await withMockResponse({ status: 200, json: { models: [] } }, async () => {
    const r = await testApiKey("AIza-good");
    assert.equal(r.ok, true);
    assert.match(r.message, /works/i);
  });
});

test("status 400 → invalid key", async () => {
  await withMockResponse({
    status: 400,
    json: { error: { message: "API key not valid" } },
  }, async () => {
    const r = await testApiKey("bad");
    assert.equal(r.ok, false);
    assert.match(r.message, /Invalid API key/i);
  });
});

test("status 401 → invalid key", async () => {
  await withMockResponse({ status: 401, json: {} }, async () => {
    const r = await testApiKey("bad");
    assert.equal(r.ok, false);
    assert.match(r.message, /Invalid API key/i);
  });
});

test("status 403 → invalid key", async () => {
  await withMockResponse({ status: 403, json: {} }, async () => {
    const r = await testApiKey("bad");
    assert.equal(r.ok, false);
    assert.match(r.message, /Invalid API key/i);
  });
});

test("status 429 → rate-limited (key may still be valid)", async () => {
  await withMockResponse({ status: 429, json: {} }, async () => {
    const r = await testApiKey("AIza-throttled");
    assert.equal(r.ok, false);
    assert.match(r.message, /Rate limited/i);
  });
});

test("other 5xx → generic API error with status code", async () => {
  await withMockResponse({
    status: 503,
    json: { error: { message: "Service unavailable" } },
  }, async () => {
    const r = await testApiKey("AIza");
    assert.equal(r.ok, false);
    assert.match(r.message, /503/);
    assert.match(r.message, /Service unavailable/i);
  });
});

test("network failure (thrown error) surfaces underlying message", async () => {
  await withMockError(new Error("getaddrinfo ENOTFOUND"), async () => {
    const r = await testApiKey("AIza");
    assert.equal(r.ok, false);
    assert.match(r.message, /ENOTFOUND/);
  });
});

test("URL is constructed against the correct Gemini list-models endpoint", async () => {
  let calledUrl = null;
  obsidianStub.requestUrl = async (opts) => {
    calledUrl = opts.url;
    return { status: 200, json: { models: [] } };
  };
  try {
    await testApiKey("AIza-test-1234");
    assert.match(calledUrl, /generativelanguage\.googleapis\.com\/v1beta\/models/);
    assert.match(calledUrl, /key=AIza-test-1234/);
  } finally {
    obsidianStub.requestUrl = origRequestUrl;
  }
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});
