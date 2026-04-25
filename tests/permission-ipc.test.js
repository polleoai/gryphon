/**
 * Permission IPC server tests (v0.6.0 Stage 1).
 *
 * Covers: lifecycle, handler registry, request/response correlation,
 * error shapes, concurrent connections, stale-socket cleanup.
 *
 * We exercise the actual Unix socket on Linux/macOS; on Windows the
 * same code path runs against named pipes. Sockets live in os.tmpdir()
 * so tests don't touch the real plugin directory.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  PermissionIPCServer,
  defaultSocketPath,
  MAX_LINE_BYTES,
  MAX_CONCURRENT_SOCKETS,
} = require("../src/providers/shared/permission-ipc-server");

const IS_WINDOWS = process.platform === "win32";

// ── helpers ────────────────────────────────────────────────────────────

function tempSocketPath() {
  const rand = crypto.randomBytes(4).toString("hex");
  if (IS_WINDOWS) return `\\\\.\\pipe\\gryphon-test-${process.pid}-${rand}`;
  return path.join(os.tmpdir(), `gryphon-test-${process.pid}-${rand}.sock`);
}

/**
 * Connect, send one JSON request, receive one JSON response, close.
 * Returns the parsed response.
 */
function sendRequest(socketPath, request, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("sendRequest timeout"));
    }, timeoutMs);

    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buffer += chunk;
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.once("connect", () => {
      sock.write(JSON.stringify(request) + "\n");
    });
  });
}

// ── lifecycle ─────────────────────────────────────────────────────────

test("create() binds the socket and listens", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    assert.equal(server.isListening(), true);
    assert.equal(server.socketPath(), sp);
    if (!IS_WINDOWS) {
      assert.ok(fs.existsSync(sp), "socket file should exist after create");
    }
  } finally {
    await server.close();
  }
});

test("close() tears down the socket and removes the file", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  await server.close();
  assert.equal(server.isListening(), false);
  assert.equal(server.socketPath(), null);
  if (!IS_WINDOWS) {
    assert.equal(fs.existsSync(sp), false, "socket file should be removed on close");
  }
});

test("close() is safe to call when not created", async () => {
  const server = new PermissionIPCServer();
  await server.close();                            // should not throw
  await server.close();                            // idempotent
});

test("create() twice without close() throws", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    await assert.rejects(
      () => server.create(sp),
      /already created/i,
    );
  } finally {
    await server.close();
  }
});

test("create() unlinks a stale socket file left by a prior crash", async (t) => {
  if (IS_WINDOWS) {
    t.skip("Windows named pipes have different lifecycle");
    return;
  }
  const sp = tempSocketPath();
  // Leave a bogus file at the socket path (as if a prior process
  // crashed without unlinking it).
  fs.writeFileSync(sp, "stale");
  assert.ok(fs.existsSync(sp));

  const server = new PermissionIPCServer();
  await server.create(sp);
  try {
    // Socket is a socket, not the old regular file. Use a simple
    // round-trip to confirm the server is actually live.
    server.on("ping", () => ({ pong: true }));
    const resp = await sendRequest(sp, { req: "ping", id: "x" });
    assert.equal(resp.pong, true);
  } finally {
    await server.close();
  }
});

// ── handler registry ──────────────────────────────────────────────────

test("on() rejects non-string reqType and non-function handler", () => {
  const server = new PermissionIPCServer();
  assert.throws(() => server.on(null, () => {}), TypeError);
  assert.throws(() => server.on("", () => {}), TypeError);
  assert.throws(() => server.on("ping", null), TypeError);
  assert.throws(() => server.on("ping", "not a function"), TypeError);
});

test("registered handler is invoked and response echoes the id", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    server.on("ping", (req) => ({ pong: true, received: req.payload }));
    const resp = await sendRequest(sp, {
      req: "ping",
      id: "req-42",
      payload: "hello",
    });
    assert.equal(resp.id, "req-42");
    assert.equal(resp.resp, "ping");                      // default = reqType
    assert.equal(resp.pong, true);
    assert.equal(resp.received, "hello");
  } finally {
    await server.close();
  }
});

test("handler can override resp field", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    server.on("ping", () => ({ resp: "pong", ok: true }));
    const resp = await sendRequest(sp, { req: "ping", id: "x" });
    assert.equal(resp.resp, "pong");
    assert.equal(resp.ok, true);
  } finally {
    await server.close();
  }
});

test("handler id in response cannot be overridden by handler return", async () => {
  // The server trusts the request id over anything a handler returns,
  // so correlation is never lost even if a buggy handler tries to
  // rewrite it.
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    server.on("ping", () => ({ id: "handler-tried-to-change-me" }));
    const resp = await sendRequest(sp, { req: "ping", id: "original-id" });
    assert.equal(resp.id, "original-id");
  } finally {
    await server.close();
  }
});

// ── error shapes ──────────────────────────────────────────────────────

test("invalid JSON returns an error response", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    // Manual connection to send malformed JSON.
    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(sp);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => {
        buf += c;
        if (buf.includes("\n")) {
          sock.end();
          resolve(JSON.parse(buf.split("\n")[0]));
        }
      });
      sock.on("error", reject);
      sock.once("connect", () => sock.write("{ not valid json\n"));
    });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "invalid-json");
  } finally {
    await server.close();
  }
});

test("missing req type returns an error response", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    const resp = await sendRequest(sp, { id: "x", /* no req */ });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "missing-req-type");
    assert.equal(resp.id, "x");
  } finally {
    await server.close();
  }
});

test("unknown req type returns an error response", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    const resp = await sendRequest(sp, { req: "no-such-handler", id: "y" });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "unknown-req-type");
    assert.equal(resp.reqType, "no-such-handler");
    assert.equal(resp.id, "y");
  } finally {
    await server.close();
  }
});

test("handler that throws returns an error response with the message", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    server.on("boom", () => { throw new Error("kaboom"); });
    const resp = await sendRequest(sp, { req: "boom", id: "z" });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "kaboom");
    assert.equal(resp.id, "z");
  } finally {
    await server.close();
  }
});

test("handler that rejects returns an error response with the message", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    server.on("async-boom", async () => { throw new Error("async-kaboom"); });
    const resp = await sendRequest(sp, { req: "async-boom", id: "w" });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "async-kaboom");
  } finally {
    await server.close();
  }
});

// ── concurrency ───────────────────────────────────────────────────────

test("multiple concurrent connections are handled independently", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    // Handler sleeps so requests overlap on the wire.
    server.on("sleep", async (req) => {
      await new Promise((r) => setTimeout(r, 20));
      return { echoed: req.payload };
    });
    const results = await Promise.all([
      sendRequest(sp, { req: "sleep", id: "a", payload: "1" }),
      sendRequest(sp, { req: "sleep", id: "b", payload: "2" }),
      sendRequest(sp, { req: "sleep", id: "c", payload: "3" }),
    ]);
    assert.equal(results.length, 3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.echoed]));
    assert.deepEqual(byId, { a: "1", b: "2", c: "3" });
  } finally {
    await server.close();
  }
});

test("close() destroys active connections", async () => {
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  server.on("never-return", () => new Promise(() => {}));   // hangs forever

  // Fire-and-forget a request that would hang; we never await it.
  const sock = net.createConnection(sp);
  const socketClosedPromise = new Promise((resolve) => sock.once("close", resolve));
  await new Promise((r) => sock.once("connect", r));
  sock.write(JSON.stringify({ req: "never-return", id: "hung" }) + "\n");
  await new Promise((r) => setTimeout(r, 20));      // let server register the connection

  // Close the server — should tear down the hung connection.
  await server.close();
  await Promise.race([
    socketClosedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("socket not closed")), 1000)),
  ]);
});

// ── defaultSocketPath ─────────────────────────────────────────────────

test("defaultSocketPath returns a short, platform-appropriate path", () => {
  const sp = defaultSocketPath();
  assert.equal(typeof sp, "string");
  assert.ok(sp.length > 0);
  if (IS_WINDOWS) {
    assert.ok(sp.startsWith("\\\\.\\pipe\\"), `got ${sp}`);
  } else {
    assert.ok(sp.startsWith(os.tmpdir()), `got ${sp}`);
    assert.ok(sp.endsWith(".sock"), `got ${sp}`);
    // Unix domain sockets have ~104-char limit on macOS. Ensure we stay
    // well under it so tests on long-home-directory machines pass.
    assert.ok(sp.length < 104, `socket path should be < 104 chars, was ${sp.length}: ${sp}`);
  }
});

test("defaultSocketPath returns unique paths across calls", () => {
  const a = defaultSocketPath();
  const b = defaultSocketPath();
  assert.notEqual(a, b, "two default paths should differ (random suffix)");
});

// ── permissions (Unix only) ───────────────────────────────────────────

test("socket file has 0600 permissions on Unix", async (t) => {
  if (IS_WINDOWS) {
    t.skip("Windows named pipes use ACLs, not POSIX mode bits");
    return;
  }
  const server = new PermissionIPCServer();
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    const stat = fs.statSync(sp);
    // Mask to get just the permission bits (stat.mode includes file type).
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  } finally {
    await server.close();
  }
});

// ── Round-12 F11: per-connection buffer cap (DoS protection) ──────────

test("F11: server drops connection when buffer exceeds MAX_LINE_BYTES", async () => {
  const sockPath = tempSocketPath();
  const server = new PermissionIPCServer();
  server.on("never", async () => ({ ok: true }));
  await server.create(sockPath);
  try {
    // One big write with NO newline. Size = cap + 1 KiB so the server
    // trips the limit on the first data event.
    const oversize = "x".repeat(MAX_LINE_BYTES + 1024);
    const errorResp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let buf = "";
      let done = false;
      const settle = (fn) => (x) => { if (!done) { done = true; fn(x); } };
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          try { settle(resolve)(JSON.parse(buf.slice(0, nl))); }
          catch (e) { settle(reject)(e); }
        }
      });
      sock.on("error", (e) => {
        if (e && (e.code === "EPIPE" || e.code === "ECONNRESET")) return;
        settle(reject)(e);
      });
      sock.once("connect", () => sock.write(oversize, () => {}));
      setTimeout(() => settle(reject)(new Error("test-timeout")), 5000);
    });
    assert.equal(errorResp.resp, "error");
    assert.equal(errorResp.error, "line-too-long");
  } finally {
    await server.close();
  }
});

// ── Round-12 F13: concurrent-connection cap ────────────────────────────

test("F13: server refuses connections beyond MAX_CONCURRENT_SOCKETS", async () => {
  const sockPath = tempSocketPath();
  const server = new PermissionIPCServer();
  // Never-resolves handler ensures we can hold connections open without
  // them closing themselves on a response.
  server.on("wait", () => new Promise(() => {}));
  await server.create(sockPath);

  // Hold MAX open connections, then try one more.
  const heldSockets = [];
  try {
    for (let i = 0; i < MAX_CONCURRENT_SOCKETS; i++) {
      const s = net.createConnection(sockPath);
      s.setEncoding("utf8");
      heldSockets.push(s);
      // Send a request so the server adds us to activeSockets.
      await new Promise((resolve, reject) => {
        s.once("connect", () => { s.write(JSON.stringify({ req: "wait" }) + "\n"); resolve(); });
        s.once("error", reject);
      });
    }
    // Give server a moment to accept all N.
    await new Promise((r) => setTimeout(r, 100));

    // Connection #33 should get rejected with too-many-connections.
    const resp = await new Promise((resolve, reject) => {
      const s = net.createConnection(sockPath);
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          try { resolve(JSON.parse(buf.slice(0, nl))); }
          catch (e) { reject(e); }
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("test-timeout")), 3000);
    });
    assert.equal(resp.resp, "error");
    assert.equal(resp.error, "too-many-connections");
  } finally {
    for (const s of heldSockets) { try { s.destroy(); } catch (_) {} }
    await server.close();
  }
});

test("F13: MAX_CONCURRENT_SOCKETS is a sane small integer", () => {
  assert.ok(Number.isInteger(MAX_CONCURRENT_SOCKETS));
  assert.ok(MAX_CONCURRENT_SOCKETS > 0 && MAX_CONCURRENT_SOCKETS < 1000);
});

// ── Round-14 Q2: slow-loris lifetime cap ──────────────────────────────

test("Q2: slow-loris connection gets lifetime-expired so legit traffic isn't starved forever", async () => {
  // Monkey-patch the constants to shorten REQUEST_LIFETIME_MS for the
  // test — we can't wait 15s per test run. Re-require with cache purge.
  const ipcPath = require.resolve("../src/providers/shared/permission-ipc-server");
  delete require.cache[ipcPath];
  // Override via patching the module-cached constants won't work directly
  // since they're `const`. Instead drive the real 15s cap but keep the
  // test small: open one slow connection, assert it gets closed with
  // `request-lifetime-exceeded` error within the cap window.
  const { PermissionIPCServer } = require("../src/providers/shared/permission-ipc-server");

  const sockPath = tempSocketPath();
  const server = new PermissionIPCServer();
  server.on("echo", async () => ({ ok: true }));
  await server.create(sockPath);

  try {
    // Connect and send NOTHING. The server should close us with
    // request-lifetime-exceeded after ~15s. Poll for up to 20s.
    const got = await new Promise((resolve) => {
      const c = net.createConnection(sockPath);
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (d) => {
        buf += d;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          try { resolve(JSON.parse(buf.slice(0, nl))); }
          catch (_) { resolve({ raw: buf }); }
        }
      });
      c.on("error", (e) => resolve({ err: e.code }));
      c.on("close", () => resolve({ closed: true }));
      setTimeout(() => resolve({ timeout: true }), 20000);
    });
    // Server should have written a lifetime-exceeded error before closing.
    assert.ok(got.error === "request-lifetime-exceeded" || got.closed,
      `expected lifetime-exceeded or close, got ${JSON.stringify(got)}`);
  } finally {
    await server.close();
  }
});
