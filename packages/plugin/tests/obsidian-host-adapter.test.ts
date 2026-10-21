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

// ── #40: a guarded request (blockAddress) never goes through requestUrl ──
const http = require("http");

function serveLocal(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, close: () => server.close(), seen })));
}

test("#40: fetch with blockAddress uses the guarded fetch, not requestUrl, and returns headers", async () => {
  requestUrlCalls.length = 0;
  const s = await serveLocal((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("direct"); });
  try {
    const r = await new ObsidianHostAdapter().fetch(`http://127.0.0.1:${s.port}/p`, { blockAddress: () => false });
    assert.equal(requestUrlCalls.length, 0, "requestUrl not used for a guarded request");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/plain", "headers reach WebFetch's content-type check");
    assert.equal(await r.text(), "direct");
  } finally { s.close(); }
});

test("#40: a redirect to the cloud-metadata address is refused (requestUrl would have followed it)", async () => {
  requestUrlCalls.length = 0;
  const s = await serveLocal((_req, res) => { res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); res.end(); });
  try {
    const block = (h) => h === "169.254.169.254";
    await assert.rejects(new ObsidianHostAdapter().fetch(`http://127.0.0.1:${s.port}/start`, { blockAddress: block }), /refusing to connect to 169\.254\.169\.254/);
    assert.equal(requestUrlCalls.length, 0);
    assert.equal(s.seen.length, 1, "only the first hop was requested");
  } finally { s.close(); }
});

test("#40: a guarded request honours HTTP_PROXY / NO_PROXY from the environment", async () => {
  const proxy = await serveLocal((_req, res) => { res.writeHead(200); res.end("via proxy"); });
  const direct = await serveLocal((_req, res) => { res.writeHead(200); res.end("direct"); });
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  try {
    delete process.env.http_proxy; delete process.env.no_proxy;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = "";
    const viaProxy = await new ObsidianHostAdapter().fetch("http://localhost:8099/x", { blockAddress: () => false });
    assert.equal(await viaProxy.text(), "via proxy");
    assert.equal(proxy.seen[0].headers.host, "localhost:8099");
    process.env.NO_PROXY = "127.0.0.1";
    const bypass = await new ObsidianHostAdapter().fetch(`http://127.0.0.1:${direct.port}/y`, { blockAddress: () => false });
    assert.equal(await bypass.text(), "direct", "NO_PROXY host is reached directly");
    assert.equal(proxy.seen.length, 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    proxy.close(); direct.close();
  }
});

test("#40: requests without blockAddress still use requestUrl (provider API calls unchanged)", async () => {
  requestUrlCalls.length = 0;
  await new ObsidianHostAdapter().fetch("https://api.example.com/v1", { method: "POST", body: "{}" });
  assert.equal(requestUrlCalls.length, 1);
});

test("#40: a direct-connection failure with no proxy configured says how to set one", async () => {
  const saved = { ...process.env };
  try {
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];
    await assert.rejects(
      new ObsidianHostAdapter().fetch("http://127.0.0.1:1/", { blockAddress: () => false, timeoutMs: 2000 }),
      /ECONNREFUSED.*set HTTPS_PROXY/,
    );
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    await assert.rejects(
      new ObsidianHostAdapter().fetch("http://localhost:8099/", { blockAddress: () => false, timeoutMs: 2000 }),
      (e) => /could not reach the configured proxy/.test(e.message) && !/set HTTPS_PROXY/.test(e.message),
    );
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
