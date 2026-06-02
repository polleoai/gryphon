/**
 * ObsidianHostAdapter — unit tests.
 *
 * The adapter lazily requires("obsidian") inside each method so it can
 * run inside Obsidian's Electron renderer without pulling in Node-only
 * globals at module load. We intercept Module._load to inject a
 * controllable stub, following the same pattern as
 * projection-calibration.test.js.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// ── obsidian stub (installed for the entire file) ─────────────────────
// The adapter calls require("obsidian") lazily inside each method.
// We hold mutable arrays so individual tests can inspect what was called.

const noticeCalls = [];
const requestUrlCalls = [];

// Default requestUrl return value; tests may shadow it by pushing a
// custom resolver to requestUrlImpl.
let requestUrlImpl = async (opts) => {
  requestUrlCalls.push(opts);
  return { status: 200, text: "ok", json: { ok: true }, headers: {} };
};

const obsidianStub = {
  Notice: function Notice(msg, ms) {
    noticeCalls.push({ msg, ms });
  },
  requestUrl: async (opts) => requestUrlImpl(opts),
};

// Intercept Module._load so require("obsidian") returns our stub.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return obsidianStub;
  return origLoad.call(this, request, ...rest);
};

// Clear call records before each test by wrapping each test's assertion
// section after a reset — we reset inside each test for clarity.
const { ObsidianHostAdapter } = require("../src/obsidian-host-adapter");

// Restore Module._load after all tests.
after(() => {
  Module._load = origLoad;
});

// ── notify ────────────────────────────────────────────────────────────

test("notify(msg, {timeoutMs}) calls Notice with correct args", () => {
  noticeCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  adapter.notify("hello world", { timeoutMs: 7000 });
  assert.equal(noticeCalls.length, 1);
  assert.equal(noticeCalls[0].msg, "hello world");
  assert.equal(noticeCalls[0].ms, 7000);
});

test("notify(msg, null) does not throw — null-opts guard", () => {
  noticeCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  assert.doesNotThrow(() => adapter.notify("safe", null));
  assert.equal(noticeCalls.length, 1);
  assert.equal(noticeCalls[0].msg, "safe");
  // null opts → default timeout of 5000
  assert.equal(noticeCalls[0].ms, 5000);
});

test("notify(msg) with no opts arg defaults to 5000ms timeout", () => {
  noticeCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  adapter.notify("bare call");
  assert.equal(noticeCalls.length, 1);
  assert.equal(noticeCalls[0].msg, "bare call");
  assert.equal(noticeCalls[0].ms, 5000);
});

test("ObsidianHostAdapter.notify accepts opts.level for contract parity but does not throw", () => {
  noticeCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  adapter.notify("oops", { level: "error" });
  adapter.notify("warn me", { level: "warn", timeoutMs: 3000 });
  adapter.notify("plain", { level: "info" });
  assert.equal(noticeCalls.length, 3);
  // level itself doesn't appear in the Notice call — Obsidian's Notice has no severity.
  assert.equal(noticeCalls[0].msg, "oops");
  assert.equal(noticeCalls[1].ms, 3000);  // timeoutMs still honored alongside level
});

// ── fetch ─────────────────────────────────────────────────────────────

test("fetch passes correct shape to requestUrl and returns fetch-like wrapper", async () => {
  requestUrlCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  const result = await adapter.fetch("https://example.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 1 }),
  });

  // requestUrl received the right options
  assert.equal(requestUrlCalls.length, 1);
  const sent = requestUrlCalls[0];
  assert.equal(sent.url, "https://example.com/api");
  assert.equal(sent.method, "POST");
  assert.deepEqual(sent.headers, { "Content-Type": "application/json" });
  assert.equal(sent.body, JSON.stringify({ x: 1 }));
  assert.equal(sent.throw, false, "throw:false prevents requestUrl from throwing on non-2xx");

  // Returned wrapper has fetch-like shape
  assert.equal(result.status, 200);
  assert.equal(typeof result.text, "function");
  assert.equal(typeof result.json, "function");
  assert.equal(await result.text(), "ok");
  assert.deepEqual(await result.json(), { ok: true });
});

test("fetch defaults method to GET when not specified", async () => {
  requestUrlCalls.length = 0;
  const adapter = new ObsidianHostAdapter();
  await adapter.fetch("https://example.com/data");
  assert.equal(requestUrlCalls.length, 1);
  assert.equal(requestUrlCalls[0].method, "GET");
});
