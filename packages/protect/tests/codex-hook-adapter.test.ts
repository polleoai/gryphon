// Codex CLI hook adapter — TOML-shape + overlay-creation tests. We
// exercise _buildHooksToml and _createCodexHomeOverlay directly.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const adapter = require("../src/hook-adapters/codex-cli");

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
  assert.match(toml, /command = "'\/usr\/bin\/node' '\/path with space\/hooks\/pretool\.js'"/);
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
    // Hooks come via env (CODEX_HOME); the one arg forces the hooks feature on
    // so a vault's .codex/config.toml can't switch them off (R43-2).
    assert.deepEqual(r.args, ["-c", "features.hooks=true"]);
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

// Issue #31: Codex >= 0.145 skips untrusted hooks silently. The overlay
// must trust every hook it writes, with Codex's own hash and key.
test("#31: _codexHookTrustHash matches Codex's canonical-JSON sha256 (verified live, codex 0.145)", () => {
  // sha256 of {"event_name":"pre_tool_use","hooks":[{"async":false,"command":"node /x/pretool.js","timeout":300,"type":"command"}],"matcher":""}
  assert.equal(
    adapter._codexHookTrustHash("PreToolUse", "", "node /x/pretool.js", 300),
    "sha256:425c5a1875dd70a65d18b62585543a832b671b349933cdbafa2f6a4717fea6ed",
  );
});

test("#31: SessionEnd timeout is clamped to 3s before hashing, as Codex does", () => {
  assert.equal(
    adapter._codexHookTrustHash("SessionEnd", "", "c", 5),
    adapter._codexHookTrustHash("SessionEnd", "", "c", 3),
  );
  assert.notEqual(
    adapter._codexHookTrustHash("PreToolUse", "", "c", 5),
    adapter._codexHookTrustHash("PreToolUse", "", "c", 3),
  );
});

test("#31: events Codex doesn't know (Notification) get no trust entry", () => {
  assert.equal(adapter._codexHookTrustHash("Notification", "", "c", 2), null);
});

test("#31: every Codex hook in the overlay config is trusted under <configPath>:<event>:0:0", () => {
  const configPath = "/tmp/overlay/config.toml";
  const toml = adapter._buildHooksToml({
    pluginDir: "/fake/plugin", nodePath: "/usr/local/bin/node", modelInstructionsFile: "", configPath,
  });
  for (const label of ["pre_tool_use", "post_tool_use", "session_start", "session_end", "user_prompt_submit"]) {
    assert.match(toml, new RegExp(`\\[hooks\\.state\\.${JSON.stringify(`${configPath}:${label}:0:0`).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\]\\ntrusted_hash = "sha256:[0-9a-f]{64}"`));
  }
  assert.equal((toml.match(/trusted_hash/g) || []).length, 5);
  // The trusted hash is the hash of the command actually rendered.
  const cmd = `'/usr/local/bin/node' '${path.join("/fake/plugin", "hooks", "pretool.js")}'`;
  if (process.platform !== "win32") {
    assert.ok(toml.includes(adapter._codexHookTrustHash("PreToolUse", "", cmd, 300)));
  }
});

test("#31: the overlay is built under a realpath and trusts its own config.toml path", () => {
  const extras = adapter.buildSpawnExtras({ pluginDir: "/fake/plugin", ipcSocketPath: "/tmp/x.sock", nodePath: "/usr/local/bin/node" });
  try {
    const overlay = extras.env.CODEX_HOME;
    assert.equal(fs.realpathSync(overlay), overlay);
    const toml = fs.readFileSync(extras.settingsFile, "utf8");
    assert.ok(toml.includes(JSON.stringify(`${path.join(overlay, "config.toml")}:pre_tool_use:0:0`)));
  } finally {
    extras.cleanup();
  }
});

test("#31/#30: the store-guard-only overlay trusts its PreToolUse guard", () => {
  const extras = adapter.buildSpawnExtras({
    nodePath: "/usr/local/bin/node",
    storeGuardOnly: { scriptPath: "/tmp/gryphon/hooks/store-guard-0123456789abcdef.js", approvalsDir: "/tmp/gryphon" },
  });
  try {
    const toml = fs.readFileSync(extras.settingsFile, "utf8");
    const key = `${path.join(extras.env.CODEX_HOME, "config.toml")}:pre_tool_use:0:0`;
    assert.ok(toml.includes(`[hooks.state.${JSON.stringify(key)}]`), toml);
    assert.equal((toml.match(/trusted_hash = "sha256:[0-9a-f]{64}"/g) || []).length, 1);
  } finally {
    extras.cleanup();
  }
});

test("R43-2: the store-guard-only spawn also forces the hooks feature on", () => {
  const extras = adapter.buildSpawnExtras({
    nodePath: "/usr/local/bin/node",
    storeGuardOnly: { scriptPath: "/tmp/gryphon/hooks/store-guard-0123456789abcdef.js", approvalsDir: "/tmp/gryphon" },
  });
  try {
    assert.deepEqual(extras.args, ["-c", "features.hooks=true"]);
  } finally {
    extras.cleanup();
  }
});

test("R43-5: UserPromptSubmit (and Stop) are hashed WITHOUT a matcher, as Codex does", () => {
  const crypto = require("crypto");
  const expected = "sha256:" + crypto.createHash("sha256").update(JSON.stringify({
    event_name: "user_prompt_submit",
    hooks: [{ async: false, command: "c", timeout: 10, type: "command" }],
  })).digest("hex");
  assert.equal(adapter._codexHookTrustHash("UserPromptSubmit", "", "c", 10), expected);
});

// R3-1: a vault's own .codex/config.toml (Codex's project layer) could start
// MCP servers at session start — verified live, codex 0.145. Every Gryphon
// overlay marks the vault and every folder above it untrusted.
test("R3-1: every overlay marks the project folder and its ancestors untrusted", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "r3-1-"));
  try {
    const real = fs.realpathSync.native(vault);
    for (const extras of [
      adapter.buildSpawnExtras({ pluginDir: "/fake/plugin", ipcSocketPath: "/tmp/x.sock", nodePath: "/usr/local/bin/node", options: { projectDir: vault } }),
      adapter.buildSpawnExtras({ nodePath: "/usr/local/bin/node", storeGuardOnly: { scriptPath: "/tmp/g/store-guard-0123456789abcdef.js", approvalsDir: "/tmp/g" }, options: { projectDir: vault } }),
      adapter.buildTrustOnlyOverlay({ projectDir: vault }),
    ]) {
      try {
        const toml = fs.readFileSync(path.join(extras.env.CODEX_HOME, "config.toml"), "utf8");
        assert.ok(toml.includes(`[projects.${JSON.stringify(real)}]\ntrust_level = "untrusted"`), toml);
        assert.ok(toml.includes(`[projects.${JSON.stringify(path.dirname(real))}]`), "ancestors too");
      } finally {
        extras.cleanup();
      }
    }
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("R2-2: TOML strings encode DEL and refuse unpaired surrogates", () => {
  assert.equal(adapter._tomlString("a\u007fb"), '"a\\u007Fb"');
  assert.equal(adapter._tomlString("C:\\v's \"x\""), '"C:\\\\v\'s \\"x\\""');
  assert.throws(() => adapter._tomlString("a\ud800b"), /unpaired surrogate/);
  assert.equal(adapter._tomlString("emoji \ud83d\ude00"), '"emoji \ud83d\ude00"');
});
