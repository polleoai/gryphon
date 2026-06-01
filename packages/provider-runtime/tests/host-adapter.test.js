const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HeadlessHostAdapter } = require("../src/host-adapter");

test("HeadlessHostAdapter.notify writes to console without throwing", () => {
  const adapter = new HeadlessHostAdapter();
  // Should not throw on any message shape
  adapter.notify("hello");
  adapter.notify("warn", { level: "warn" });
  adapter.notify("with timeout", { timeoutMs: 5000 });
});

test("HeadlessHostAdapter.notify routes to console.error / warn / log by opts.level", () => {
  const adapter = new HeadlessHostAdapter();
  const calls = { error: [], warn: [], log: [] };
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => calls.error.push(a);
  console.warn  = (...a) => calls.warn.push(a);
  console.log   = (...a) => calls.log.push(a);
  try {
    adapter.notify("E", { level: "error" });
    adapter.notify("W", { level: "warn" });
    adapter.notify("I", { level: "info" });
    adapter.notify("D");                       // default → info → log
    adapter.notify("N", null);                 // null opts → must not throw → log
    assert.equal(calls.error.length, 1);
    assert.match(calls.error[0][0], /E$/);
    assert.equal(calls.warn.length, 1);
    assert.match(calls.warn[0][0], /W$/);
    assert.equal(calls.log.length, 3);
  } finally {
    console.error = original.error;
    console.warn  = original.warn;
    console.log   = original.log;
  }
});

test("HeadlessHostAdapter.fetch returns a response with status + text()", async () => {
  const adapter = new HeadlessHostAdapter();
  // We don't make a real network call in the test — just verify the shape
  // by stubbing globalThis.fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => "ok",
    json: async () => ({ ok: true }),
  });
  try {
    const res = await adapter.fetch("https://example.test/");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
