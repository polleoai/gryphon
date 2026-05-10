/**
 * Regression tests for IPC server auto-recovery.
 *
 * Scenario: Claude Code mode with Protected Mode ON + Auto-deny ON relies on
 * the hook path to apply NFKC normalization. If the IPC server drops
 * into `!isListening` between a plugin disable+enable cycle (or any
 * close→create race), a spawn landing in that window would take the
 * deny-glob fallback and silently lose Unicode-obfuscation handling.
 *
 * The `ensureIpcListening()` method on plugin recovers from that state
 * by re-invoking `create()`, and the `_creatingPromise` guard on
 * PermissionIPCServer dedupes concurrent creates so the race doesn't
 * leak a second server instance.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PermissionIPCServer } = require("../src/permission-ipc-server");

function tmpSock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-recovery-"));
  return path.join(dir, "sock");
}

test("isListening is false before create", () => {
  const srv = new PermissionIPCServer();
  assert.equal(srv.isListening(), false);
});

test("isListening is true after create, false after close", async () => {
  const srv = new PermissionIPCServer();
  const sock = tmpSock();
  await srv.create(sock);
  assert.equal(srv.isListening(), true);
  await srv.close();
  assert.equal(srv.isListening(), false);
});

test("create can be called again after close (recovery scenario)", async () => {
  const srv = new PermissionIPCServer();
  const sock = tmpSock();
  await srv.create(sock);
  await srv.close();
  // This is the recovery path — the prior close nulled _server, create
  // should succeed again.
  await srv.create(tmpSock());
  assert.equal(srv.isListening(), true);
  await srv.close();
});

test("concurrent create() calls are deduped (no double-bind race)", async () => {
  const srv = new PermissionIPCServer();
  const sock = tmpSock();
  // Fire two creates concurrently — before the in-flight guard, both
  // would have passed the `if (this._server)` check and raced to bind.
  const p1 = srv.create(sock);
  const p2 = srv.create(tmpSock());
  // Both should resolve (the second returns the first's promise) and
  // the server should be listening exactly once.
  await Promise.all([p1, p2]);
  assert.equal(srv.isListening(), true);
  // Quick smoke check: _creatingPromise should be null after both settle.
  assert.equal(srv._creatingPromise, null);
  await srv.close();
});

test("create throws 'already created' if called when already listening", async () => {
  const srv = new PermissionIPCServer();
  const sock = tmpSock();
  await srv.create(sock);
  await assert.rejects(
    () => srv.create(tmpSock()),
    /already created/,
  );
  await srv.close();
});

// ── ensureIpcListening behavior via source check ────────────────────

test("plugin.js exports async ensureIpcListening", () => {
  const src = fs.readFileSync(require.resolve("../../plugin/src/plugin.js"), "utf8");
  assert.match(
    src,
    /async\s+ensureIpcListening\s*\(/,
    "plugin.js must expose an async ensureIpcListening method for CLI recovery",
  );
  assert.match(
    src,
    /ipcServer\.isListening\(\)/,
    "ensureIpcListening must check current listening state as the fast path",
  );
  assert.match(
    src,
    /ipc-recovery-timeout/,
    "ensureIpcListening must bound recovery with a timeout so a hung create() can't stall spawn",
  );
});

test("chat-view.js awaits ensureIpcListening before createProvider", () => {
  const src = fs.readFileSync(require.resolve("../../plugin/src/chat-view.js"), "utf8");
  // The await must appear BEFORE the createProvider call in the spawn
  // flow. Source-order check: ensureIpcListening should appear in the
  // same method as createProvider and should precede it.
  const awaitPos = src.indexOf("await this.plugin.ensureIpcListening(");
  const createPos = src.indexOf("this.claudeProcess = createProvider(");
  assert.ok(awaitPos > 0, "chat-view.js must await ensureIpcListening before spawning");
  assert.ok(createPos > 0, "chat-view.js must still create the provider");
  assert.ok(
    awaitPos < createPos,
    "ensureIpcListening must run BEFORE createProvider to guarantee the hook path is available when CLI spawns",
  );
});
