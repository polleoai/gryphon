// Codex CLI hook adapter — TOML-shape + overlay-creation tests. We
// exercise _buildHooksToml and _createCodexHomeOverlay directly.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const adapter = require("../src/providers/shared/hook-adapters/codex-cli");

test("kind is 'codex-cli'", () => {
  assert.equal(adapter.kind, "codex-cli");
});

test("_buildHooksToml emits all six hook events with correct shape", () => {
  const toml = adapter._buildHooksToml({
    pluginDir: "/tmp/plugin",
    nodePath: "/usr/bin/node",
  });
  // Each event should appear as `[[hooks.<Event>]]`.
  for (const event of ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification"]) {
    assert.ok(toml.includes(`[[hooks.${event}]]`),
      `${event} missing from emitted TOML`);
    assert.ok(toml.includes(`[[hooks.${event}.hooks]]`),
      `${event}.hooks block missing`);
  }
  // Each entry should be type=command + reference the script path.
  assert.match(toml, /type = "command"/);
  assert.match(toml, /\/tmp\/plugin\/hooks\/pretool\.js/);
  assert.match(toml, /\/tmp\/plugin\/hooks\/posttool\.js/);
  assert.match(toml, /\/usr\/bin\/node/);
});

test("_buildHooksToml uses POSIX quoting on macOS/Linux", () => {
  if (process.platform === "win32") return;
  const toml = adapter._buildHooksToml({
    pluginDir: "/path with space",
    nodePath: "/usr/bin/node",
  });
  // POSIX command form: "node" "script" — JSON-quoted.
  assert.match(toml, /command = "\\"\/usr\/bin\/node\\" \\"\/path with space\/hooks\/pretool\.js\\""/);
});

test("_createCodexHomeOverlay creates a tmpdir with config.toml + symlinked auth.json (when real exists)", () => {
  const overlay = adapter._createCodexHomeOverlay({
    pluginDir: "/tmp/plugin",
    nodePath: "/usr/bin/node",
  });
  try {
    assert.ok(fs.existsSync(overlay), "overlay dir created");
    assert.ok(fs.existsSync(path.join(overlay, "config.toml")), "config.toml present");

    // If the user has a real ~/.codex/auth.json, it should be a
    // symlink in the overlay. If not (clean machine), we just verify
    // the absence is silent (no thrown error).
    const realAuth = path.join(os.homedir(), ".codex", "auth.json");
    if (fs.existsSync(realAuth)) {
      const linked = path.join(overlay, "auth.json");
      assert.ok(fs.existsSync(linked), "auth.json present in overlay");
      const stat = fs.lstatSync(linked);
      assert.ok(stat.isSymbolicLink(), "auth.json is a symlink (not a copy)");
      // The symlink should point at the real file.
      assert.equal(fs.readlinkSync(linked), realAuth);
    }

    // The user's real config.toml is NOT preserved — Gryphon owns
    // the hooks section and writes a fresh config.
    const realConfig = path.join(os.homedir(), ".codex", "config.toml");
    if (fs.existsSync(realConfig)) {
      const overlayConfig = path.join(overlay, "config.toml");
      // Both exist, but the overlay's is OUR generated TOML (not a
      // symlink to the real one).
      const stat = fs.lstatSync(overlayConfig);
      assert.equal(stat.isSymbolicLink(), false,
        "overlay config.toml must be Gryphon-written, not symlinked");
    }
  } finally {
    adapter._cleanupOverlay(overlay);
    assert.equal(fs.existsSync(overlay), false, "cleanup removes the overlay");
  }
});

test("_cleanupOverlay is safe to call on missing/null paths", () => {
  // Should not throw.
  adapter._cleanupOverlay(null);
  adapter._cleanupOverlay(undefined);
  adapter._cleanupOverlay("/nonexistent/path/that/should/not/exist");
});

test("buildSpawnExtras returns env with CODEX_HOME + GRYPHON_PERMISSION_SOCKET", () => {
  const r = adapter.buildSpawnExtras({
    pluginDir: "/tmp/plugin",
    ipcSocketPath: "/tmp/gryphon.sock",
    nodePath: "/usr/bin/node",
  });
  try {
    assert.ok(r.env.CODEX_HOME);
    assert.equal(r.env.GRYPHON_PERMISSION_SOCKET, "/tmp/gryphon.sock");
    // No CLI args needed — Codex picks up hooks via env.
    assert.deepEqual(r.args, []);
    // settingsFile is the config.toml path inside the overlay.
    assert.match(r.settingsFile, /config\.toml$/);
    assert.equal(r.env.CODEX_HOME, path.dirname(r.settingsFile));
  } finally {
    r.cleanup();
  }
});

test("buildSpawnExtras returns null when required inputs are missing (defensive)", () => {
  assert.equal(adapter.buildSpawnExtras({}), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/x" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/x", ipcSocketPath: "/s" }), null);
});

test("QA-V13H-A: _createCodexHomeOverlay rolls back tmpdir when a write fails", () => {
  // Simulate a partial write failure by stubbing fs.writeFileSync to
  // throw on the second call (config.toml). Without rollback, the
  // overlay tmpdir + the model-instructions.md from the first
  // successful write would leak in os.tmpdir() with no cleanup
  // function reaching the caller.
  const realWrite = fs.writeFileSync;
  let calls = 0;
  let overlayCreated = null;
  fs.writeFileSync = function patched(p, ...rest) {
    calls += 1;
    // Capture the overlay path from the first write target.
    if (calls === 1) {
      overlayCreated = path.dirname(p);
      return realWrite.call(fs, p, ...rest);
    }
    // Second write throws — simulating disk-full / EPERM / antivirus.
    const err = new Error("simulated EIO during config.toml write");
    err.code = "EIO";
    throw err;
  };
  try {
    assert.throws(() =>
      adapter._createCodexHomeOverlay({ pluginDir: "/x", nodePath: "/usr/bin/node" }),
    );
    assert.ok(overlayCreated, "first write recorded the overlay path");
    assert.ok(!fs.existsSync(overlayCreated),
      `overlay tmpdir leaked after partial-write failure: ${overlayCreated}`);
  } finally {
    fs.writeFileSync = realWrite;
    // belt-and-braces: if the assertion fails and rollback didn't fire,
    // clean up so the test run doesn't leave artifacts behind.
    if (overlayCreated && fs.existsSync(overlayCreated)) {
      fs.rmSync(overlayCreated, { recursive: true, force: true });
    }
  }
});
