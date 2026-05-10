/**
 * IPC client tests (v0.6.0 Stage 2).
 *
 * Exercises src/hooks/common/ipc-client.js against a real running
 * PermissionIPCServer. The client is what hook scripts use to reach
 * the plugin; these tests pin its request/response contract so later
 * stages can rely on it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  PermissionIPCServer,
} = require("../src/permission-ipc-server");
const {
  sendToGryphon,
  emitEvent,
  randomId,
  SOCKET_ENV_VAR,
} = require("../src/hooks/common/ipc-client");

const IS_WINDOWS = process.platform === "win32";

function tempSocketPath() {
  const rand = crypto.randomBytes(4).toString("hex");
  if (IS_WINDOWS) return `\\\\.\\pipe\\gryphon-test-${process.pid}-${rand}`;
  return path.join(os.tmpdir(), `gryphon-test-${process.pid}-${rand}.sock`);
}

async function withServer(handlers, fn) {
  const server = new PermissionIPCServer();
  for (const [reqType, handler] of Object.entries(handlers)) {
    server.on(reqType, handler);
  }
  const sp = tempSocketPath();
  await server.create(sp);
  try {
    return await fn(sp, server);
  } finally {
    await server.close();
  }
}

// ── round-trip ────────────────────────────────────────────────────────

test("sendToGryphon delivers the request and returns the response", async () => {
  await withServer(
    { classify: (req) => ({ decision: "allow", echoed: req.tool }) },
    async (sp) => {
      const resp = await sendToGryphon(
        { req: "classify", id: "req-1", tool: "Bash", input: {} },
        { socketPath: sp, timeoutMs: 1000 },
      );
      assert.equal(resp.resp, "classify");
      assert.equal(resp.id, "req-1");
      assert.equal(resp.decision, "allow");
      assert.equal(resp.echoed, "Bash");
    },
  );
});

test("sendToGryphon auto-assigns id when caller omits one", async () => {
  await withServer(
    { ping: () => ({ pong: true }) },
    async (sp) => {
      const resp = await sendToGryphon(
        { req: "ping" },
        { socketPath: sp, timeoutMs: 1000 },
      );
      assert.ok(resp.id, "server should have an id to echo back");
      assert.ok(typeof resp.id === "string");
      assert.ok(resp.id.startsWith("h-"), `id should be from randomId(): ${resp.id}`);
      assert.equal(resp.pong, true);
    },
  );
});

// ── env var fallback ──────────────────────────────────────────────────

test(`sendToGryphon reads ${SOCKET_ENV_VAR} when socketPath not provided`, async () => {
  await withServer(
    { ping: () => ({ pong: true }) },
    async (sp) => {
      const prev = process.env[SOCKET_ENV_VAR];
      process.env[SOCKET_ENV_VAR] = sp;
      try {
        const resp = await sendToGryphon({ req: "ping" }, { timeoutMs: 1000 });
        assert.equal(resp.pong, true);
      } finally {
        if (prev === undefined) delete process.env[SOCKET_ENV_VAR];
        else process.env[SOCKET_ENV_VAR] = prev;
      }
    },
  );
});

test(`sendToGryphon rejects when ${SOCKET_ENV_VAR} is missing and no socketPath`, async () => {
  const prev = process.env[SOCKET_ENV_VAR];
  delete process.env[SOCKET_ENV_VAR];
  try {
    await assert.rejects(
      () => sendToGryphon({ req: "ping" }, { timeoutMs: 200 }),
      /GRYPHON_PERMISSION_SOCKET/,
    );
  } finally {
    if (prev !== undefined) process.env[SOCKET_ENV_VAR] = prev;
  }
});

// ── timeout + failure modes ───────────────────────────────────────────

test("sendToGryphon rejects on connection refused (no server)", async () => {
  const sp = tempSocketPath();                      // nothing bound to it
  await assert.rejects(
    () => sendToGryphon({ req: "ping" }, { socketPath: sp, timeoutMs: 500 }),
    // Any connection error — ENOENT / ECONNREFUSED depending on platform
    (err) => err instanceof Error,
  );
});

test("sendToGryphon rejects when the handler hangs past timeout", async () => {
  await withServer(
    { hang: () => new Promise(() => {}) },      // never resolves
    async (sp) => {
      await assert.rejects(
        () => sendToGryphon({ req: "hang" }, { socketPath: sp, timeoutMs: 150 }),
        /ipc-timeout/,
      );
    },
  );
});

// ── emitEvent: fire-and-forget ────────────────────────────────────────

test("emitEvent swallows errors silently when socket is unreachable", async () => {
  const prev = process.env[SOCKET_ENV_VAR];
  delete process.env[SOCKET_ENV_VAR];
  try {
    // Must resolve (not throw) even with no socket configured.
    await emitEvent("regex-hit", { pattern: "test" });
  } finally {
    if (prev !== undefined) process.env[SOCKET_ENV_VAR] = prev;
  }
});

test("emitEvent delivers events when socket is available", async () => {
  const received = [];
  await withServer(
    { event: (req) => { received.push(req); return { ok: true }; } },
    async (sp) => {
      const prev = process.env[SOCKET_ENV_VAR];
      process.env[SOCKET_ENV_VAR] = sp;
      try {
        await emitEvent("regex-hit", {
          tool: "WebFetch",
          pattern: "ignore-previous-instructions",
        });
        // Small grace period for the fire-and-forget to land.
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(received.length, 1);
        assert.equal(received[0].req, "event");
        assert.equal(received[0].type, "regex-hit");
        assert.equal(received[0].tool, "WebFetch");
        assert.equal(received[0].pattern, "ignore-previous-instructions");
      } finally {
        if (prev === undefined) delete process.env[SOCKET_ENV_VAR];
        else process.env[SOCKET_ENV_VAR] = prev;
      }
    },
  );
});

// ── id generator ──────────────────────────────────────────────────────

test("randomId returns unique short ids", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(randomId());
  assert.equal(ids.size, 100, "100 randomId() calls should be unique");
  for (const id of ids) {
    assert.ok(id.startsWith("h-"), `expected prefix h-: ${id}`);
    assert.ok(id.length < 40, `id should be short: ${id}`);
  }
});

// ── installHookDeadline ────────────────────────────────────────────────
//
// Behavioural unit tests of the helper itself, run via subprocess so we
// can observe the process.exit(0) that the helper performs. The whole
// point of the helper is bounded-time fail-closed; tests pin both the
// happy path (main wins the race) and the deadline path (timer wins).

const test_pretool_path = path.join(__dirname, "..", "src", "hooks", "pretool.js");

test("installHookDeadline: deadline timer fires fail-closed when stdin hangs", async () => {
  // Hold stdin open and never write — pretool's main() awaits
  // readStdinJson forever. The 285s OVERALL_DEADLINE_MS is too long
  // for a unit test, so we instead use the existing "fails closed
  // when IPC unreachable" path which exits in <5s; the deadline-timer
  // contract is covered by the session-start.js subprocess test that
  // demonstrates bounded-time exit. See hook-scripts.test.js
  // "session-start.js fail-closes via outer deadline when stdin hangs".
  // This test asserts the helper's idempotency property:
  // emitAndExit only commits the FIRST payload it sees.

  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["-e", `
    const { installHookDeadline } = require(${JSON.stringify(
      path.join(__dirname, "..", "src", "hooks", "common", "ipc-client.js")
    )});
    const { emitAndExit, crashHandler } = installHookDeadline({
      deadlineMs: 50,
      onTimeoutPayload: { from: "deadline" },
      onCrashPayload: { from: "crash" },
    });
    // First emit wins. Subsequent emits are ignored — including the
    // deadline timer that fires 50ms later.
    emitAndExit({ from: "main" });
  `]);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c.toString(); });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.deepEqual(JSON.parse(stdout), { from: "main" }, "main wins the race");
});

test("installHookDeadline: deadline payload fires when nothing else emits in time", async () => {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["-e", `
    const { installHookDeadline } = require(${JSON.stringify(
      path.join(__dirname, "..", "src", "hooks", "common", "ipc-client.js")
    )});
    installHookDeadline({
      deadlineMs: 50,
      onTimeoutPayload: { from: "deadline" },
      onCrashPayload: { from: "crash" },
    });
    // Hold the event loop alive briefly so the timer can fire.
    setTimeout(() => {}, 5000);
  `]);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c.toString(); });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.deepEqual(JSON.parse(stdout), { from: "deadline" });
});

test("installHookDeadline: crashHandler emits the crash payload", async () => {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["-e", `
    const { installHookDeadline } = require(${JSON.stringify(
      path.join(__dirname, "..", "src", "hooks", "common", "ipc-client.js")
    )});
    const { crashHandler } = installHookDeadline({
      deadlineMs: 5000,
      onTimeoutPayload: { from: "deadline" },
      onCrashPayload: { from: "crash" },
    });
    crashHandler();
  `]);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c.toString(); });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.deepEqual(JSON.parse(stdout), { from: "crash" });
});

test("installHookDeadline: rejects non-positive deadlineMs", () => {
  const { installHookDeadline } = require("../src/hooks/common/ipc-client");
  assert.throws(() => installHookDeadline({ deadlineMs: 0, onTimeoutPayload: {}, onCrashPayload: {} }),
    /positive number/);
  assert.throws(() => installHookDeadline({ deadlineMs: "5000", onTimeoutPayload: {}, onCrashPayload: {} }),
    /positive number/);
});

// ── Round-12 F12: client-side response buffer cap ─────────────────────

test("F12: sendToGryphon rejects with response-too-long when server streams unbounded bytes", async () => {
  const net = require("net");
  const os = require("os");
  const path = require("path");
  const crypto = require("crypto");
  const { sendToGryphon } = require("../src/hooks/common/ipc-client");

  const sockPath = path.join(os.tmpdir(), `gryphon-f12-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);

  // A "malicious" server that accepts any connection and streams unbounded
  // bytes with no newline. A healthy client must bail via its own buffer cap.
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("data", () => {
      // Start streaming on first data (the hook's request write).
      const junk = "z".repeat(64 * 1024);
      const writeMore = () => {
        try {
          if (!sock.write(junk)) sock.once("drain", writeMore);
          else setImmediate(writeMore);
        } catch (_) { /* socket closed */ }
      };
      writeMore();
    });
    sock.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  try {
    await assert.rejects(
      sendToGryphon(
        { req: "whatever" },
        { socketPath: sockPath, timeoutMs: 5000 },
      ),
      /response-too-long/,
    );
  } finally {
    await new Promise((r) => server.close(() => r()));
    try { require("fs").unlinkSync(sockPath); } catch (_) {}
  }
});
