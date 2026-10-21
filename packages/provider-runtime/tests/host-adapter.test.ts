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

test("HeadlessHostAdapter.notify routes to console.error / warn / debug by opts.level", () => {
  const adapter = new HeadlessHostAdapter();
  const calls = { error: [], warn: [], debug: [] };
  const original = { error: console.error, warn: console.warn, debug: console.debug };
  console.error = (...a) => calls.error.push(a);
  console.warn  = (...a) => calls.warn.push(a);
  console.debug = (...a) => calls.debug.push(a);
  try {
    adapter.notify("E", { level: "error" });
    adapter.notify("W", { level: "warn" });
    adapter.notify("I", { level: "info" });
    adapter.notify("D");                       // default → info → debug
    adapter.notify("N", null);                 // null opts → must not throw → debug
    assert.equal(calls.error.length, 1);
    assert.match(calls.error[0][0], /E$/);
    assert.equal(calls.warn.length, 1);
    assert.match(calls.warn[0][0], /W$/);
    assert.equal(calls.debug.length, 3);
  } finally {
    console.error = original.error;
    console.warn  = original.warn;
    console.debug = original.debug;
  }
});

test("HeadlessHostAdapter.fetch returns a response with status + text()", async () => {
  // No real network call: an injected fetch stands in for undici's.
  const seen: unknown[] = [];
  const adapter = new HeadlessHostAdapter({
    fetchImpl: async (url: string, opts?: unknown) => {
      seen.push([url, opts]);
      return { status: 200, text: async () => "ok", json: async () => ({ ok: true }) };
    },
  });
  const res = await adapter.fetch("https://example.test/") as { status: number; text(): Promise<string> };
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.deepEqual(seen, [["https://example.test/", {}]]);
});

test("HeadlessHostAdapter.fetch defaults to nodeFetch (node http, no global fetch)", async () => {
  const http = require("http");
  const server = http.createServer((_req, res) => { res.writeHead(201); res.end("from-undici"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const { port } = server.address();
    const res = await new HeadlessHostAdapter().fetch(`http://127.0.0.1:${port}/`) as { status: number; text(): Promise<string> };
    assert.equal(res.status, 201);
    assert.equal(await res.text(), "from-undici");
  } finally {
    server.close();
  }
});
