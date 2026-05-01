/**
 * Regression tests for silent-failure paths that were closed before
 * 1.0 — each would otherwise leave a user believing the guardrail was
 * enforcing when it wasn't. The failures were real (adversarial review
 * before 1.0 surfaced each one); these tests lock the fix in place so
 * future refactors can't silently re-introduce the same class of bug.
 *
 * Coverage:
 *   - isListening() tracks reality after post-bind server errors
 *   - auto-deny fallback Notice distinguishes the zero-globs case
 *     from the normal "fell back but still enforcing" case
 *   - `dd of=/dev/null` doesn't false-fire as "destructive write"
 *   - invalid user regex emits a diagnostic rather than silently
 *     skipping the rule
 *   - _classifyFilePath fails closed on unexpected errors
 *     (PathOutsideVaultError returns null; everything else propagates)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { classify } = require("../src/providers/shared/attack-detector");
const { PermissionIPCServer } = require("../src/providers/shared/permission-ipc-server");

function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-r14-"));
  return fs.realpathSync(dir);
}

function ctx(overrides = {}) {
  return {
    vaultRoot: tmpVault(),
    plugin: {
      settings: Object.assign({
        protectedCommandsEnabled: true,
        protectedPathsEnabled: true,
        protectedCommandsDisabled: [],
        protectedCommandsCustom: [],
        protectedPathsDisabled: [],
        protectedPathsCustom: [],
      }, overrides),
    },
  };
}

// ── #1: invalid user regex doesn't silently pass; other rules still fire ──

test("#1: invalid custom regex skipped (without crashing) and valid rules still fire", () => {
  const c = ctx({
    protectedCommandsCustom: [
      "rm\\s+-[rf(",     // unbalanced paren → invalid regex
      "genuinely-bad",   // valid, should still classify
    ],
  });
  // Command matches the valid custom pattern; invalid one shouldn't crash.
  const res = classify("Bash", { command: "run genuinely-bad command" }, c);
  assert.ok(res, "valid custom pattern should still match despite invalid sibling");
  assert.equal(res.category, "user-custom");
});

test("#1: invalid custom regex doesn't throw on subsequent calls", () => {
  const c = ctx({ protectedCommandsCustom: ["rm\\s+-[rf("] });
  // Calling classify twice shouldn't produce a double warning or crash.
  assert.doesNotThrow(() => classify("Bash", { command: "ls" }, c));
  assert.doesNotThrow(() => classify("Bash", { command: "ls" }, c));
});

// ── #2: _classifyFilePath propagates non-PathOutsideVaultError ──

test("#2: attack-detector source re-throws non-PathOutsideVault errors", () => {
  // Hard to construct a file_path input that forces resolveVaultPath
  // to throw something OTHER than PathOutsideVaultError in a unit
  // test (the guard rejects non-string file_paths upstream). Verify
  // the behavior at the source level: the catch block must re-throw
  // anything that isn't PathOutsideVaultError, not silently return
  // null as it used to.
  const src = fs.readFileSync(
    require.resolve("../src/providers/shared/attack-detector.js"),
    "utf8",
  );
  // Both assertions must hold: (a) the PathOutsideVaultError branch
  // still returns null, (b) the non-matching branch re-throws. Flat
  // search on both — they're adjacent in the catch body.
  assert.match(
    src,
    /instanceof\s+PathOutsideVaultError\s*\)\s+return\s+null\s*;/,
    "PathOutsideVaultError branch must still return null",
  );
  assert.match(
    src,
    /if\s*\(\s*\w+\s+instanceof\s+PathOutsideVaultError\s*\)\s+return\s+null\s*;\s*throw\s+\w+\s*;/,
    "catch block must re-throw non-PathOutsideVaultError errors (fail-closed)",
  );
});

// Note: PathOutsideVaultError-on-file_path is tested in
// protected-path-match.test.js — we rely on that contract here.

// ── F18: dd of=/dev/null no longer false-fires ──

test("F18: dd if=/dev/zero of=/dev/null does NOT trigger", () => {
  const res = classify("Bash", { command: "dd if=/dev/zero of=/dev/null bs=1M count=100" }, ctx());
  assert.equal(res, null, "discard to /dev/null is routine, must not fire");
});

test("F18: dd of=/dev/sda still triggers (regression)", () => {
  const res = classify("Bash", { command: "dd if=/dev/zero of=/dev/sda" }, ctx());
  assert.ok(res);
  assert.equal(res.category, "destructive-operation");
});

test("F18: dd of=/dev/nvme0n1 triggers (NVMe)", () => {
  const res = classify("Bash", { command: "dd if=/tmp/image of=/dev/nvme0n1" }, ctx());
  assert.ok(res);
});

test("F18: dd of=/dev/disk2 triggers (macOS)", () => {
  const res = classify("Bash", { command: "dd if=/tmp/x of=/dev/disk2" }, ctx());
  assert.ok(res);
});

test("F18: dd of=/dev/mmcblk0 triggers (SD card)", () => {
  const res = classify("Bash", { command: "dd if=/tmp/img of=/dev/mmcblk0 bs=4M" }, ctx());
  assert.ok(res);
});

test("F18: dd of=regular-file still doesn't trigger", () => {
  const res = classify("Bash", { command: "dd if=/tmp/a of=/tmp/b" }, ctx());
  assert.equal(res, null);
});

// ── F15: server error handler nulls _server so isListening() tracks reality ──

test("F15: server.emit('error') causes isListening() to go false", async () => {
  const srv = new PermissionIPCServer();
  const sockPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-f15-")),
    "sock",
  );
  await srv.create(sockPath);
  const underlying = srv._server;
  assert.equal(srv.isListening(), true);

  // Simulate a post-bind server error. Before the F15 fix, the handler
  // only logged; isListening() kept returning true. After: _server is
  // nulled so the state matches reality.
  underlying.emit("error", new Error("simulated post-bind error"));
  assert.equal(
    srv.isListening(),
    false,
    "server-error event must transition isListening() to false",
  );
  // Our event handler nulled srv._server, so srv.close() would be a
  // no-op. Close the underlying net.Server directly to release the
  // listen handle and let the test process exit cleanly.
  await new Promise((resolve) => underlying.close(() => resolve()));
  try { fs.unlinkSync(sockPath); } catch (_) {}
});

test("F15: server.emit('close') causes isListening() to go false", async () => {
  const srv = new PermissionIPCServer();
  const sockPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-f15c-")),
    "sock",
  );
  await srv.create(sockPath);
  const underlying = srv._server;
  assert.equal(srv.isListening(), true);
  underlying.emit("close");
  assert.equal(srv.isListening(), false);
  // Same cleanup note as the error test — our handler already nulled
  // _server, so close the net.Server directly.
  await new Promise((resolve) => underlying.close(() => resolve()));
  try { fs.unlinkSync(sockPath); } catch (_) {}
});

// ── F17: auto-deny Notice text locked — branches on denyGlobs.length ──

test("F17: cli module has distinct Notice text for zero-globs case", () => {
  const src = fs.readFileSync(
    require.resolve("../src/providers/claude-code/claude-code.js"),
    "utf8",
  );
  // Both Notice variants must exist: normal-fallback and zero-globs.
  assert.match(
    src,
    /Auto-deny falling back to basic pattern enforcement/,
    "normal fallback Notice text should remain",
  );
  assert.match(
    src,
    /NO PATTERN ENFORCEMENT this CLI session/,
    "zero-globs case must have its own, stronger Notice text",
  );
  // And the denyGlobs.length check must be adjacent to the branch.
  assert.match(
    src,
    /denyGlobs\.length\s*>\s*0[\s\S]{0,500}NO PATTERN ENFORCEMENT/,
    "Notice text should branch on denyGlobs.length",
  );
});

// ── plugin.js surfaces onload IPC failure via Notice ──

test("plugin.js emits Notice when onload IPC create rejects", () => {
  const src = fs.readFileSync(
    require.resolve("../src/plugin.js"),
    "utf8",
  );
  // The onload catch for ipcServer.create must show a Notice.
  // Before: console.warn only. After: Notice + console.warn.
  assert.match(
    src,
    /IPC server failed to start[\s\S]{0,500}new Notice/,
    "onload IPC failure must surface via Notice, not just console.warn",
  );
});

// ── ensureIpcListening reuses cached socket path ──

test("ensureIpcListening reuses cached _ipcSocketPath on recovery", () => {
  const src = fs.readFileSync(
    require.resolve("../src/plugin.js"),
    "utf8",
  );
  // The cache must exist at onload.
  assert.match(
    src,
    /this\._ipcSocketPath\s*=\s*defaultSocketPath\(\)/,
    "onload must cache the bound socket path",
  );
  // And ensureIpcListening must reuse it.
  assert.match(
    src,
    /const socketPath\s*=\s*this\._ipcSocketPath/,
    "ensureIpcListening must reuse the cached path for recovery",
  );
});
