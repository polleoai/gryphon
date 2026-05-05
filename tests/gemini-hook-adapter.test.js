// Gemini CLI hook adapter — JSON-shape + spawn-extras tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const adapter = require("../src/providers/shared/hook-adapters/gemini-cli");

test("kind is 'gemini-cli'", () => {
  assert.equal(adapter.kind, "gemini-cli");
});

test("_buildHooksJson emits Gemini-named events (BeforeTool, AfterTool, etc.)", () => {
  const settings = adapter._buildHooksJson({
    pluginDir: "/tmp/plugin",
    nodePath: "/usr/bin/node",
  });
  assert.ok(settings.hooks);
  // Event names must be Gemini-flavored, NOT Claude Code's.
  for (const event of ["BeforeTool", "AfterTool", "SessionStart", "SessionEnd", "BeforeAgent", "Notification"]) {
    assert.ok(settings.hooks[event], `${event} missing from hooks`);
    assert.ok(Array.isArray(settings.hooks[event]));
    const entry = settings.hooks[event][0];
    assert.ok(entry.matcher !== undefined);
    assert.ok(Array.isArray(entry.hooks));
    assert.equal(entry.hooks[0].type, "command");
    assert.match(entry.hooks[0].command, /pretool|posttool|session|user-prompt|notification/i);
  }
  // Must NOT include Claude-Code-specific names.
  assert.equal(settings.hooks.PreToolUse, undefined,
    "Gemini config should not use 'PreToolUse' — it uses 'BeforeTool'");
  assert.equal(settings.hooks.PostToolUse, undefined);
});

test("_buildHooksJson sets timeout in MILLISECONDS (not seconds — Gemini-specific quirk)", () => {
  // Reported user-bug 2026-05-03: Gemini's hook timeout field uses
  // millisecond units, while Claude Code and Codex CLI treat the
  // same field as seconds. DEFAULT_HOOK_TIMEOUTS is in seconds
  // (PreToolUse: 300), so the Gemini adapter must multiply by 1000.
  // Without this fix, the hook fires the modal but Gemini times
  // out in 300 ms, falls back to default-allow, and the tool runs
  // before the user can click.
  const settings = adapter._buildHooksJson({
    pluginDir: "/tmp/plugin",
    nodePath: "/usr/bin/node",
  });
  const beforeToolTimeout = settings.hooks.BeforeTool[0].hooks[0].timeout;
  // PreToolUse default is 300 seconds → 300_000 ms
  assert.equal(beforeToolTimeout, 300_000,
    "BeforeTool timeout must be 300_000 ms (5 min), not 300 (which Gemini reads as 0.3 s)");
});

test("_buildHooksJson uses POSIX quoting on macOS/Linux", () => {
  if (process.platform === "win32") return;
  const settings = adapter._buildHooksJson({
    pluginDir: "/path with space",
    nodePath: "/usr/bin/node",
  });
  const beforeToolCmd = settings.hooks.BeforeTool[0].hooks[0].command;
  assert.match(beforeToolCmd, /^"\/usr\/bin\/node" "\/path with space\/hooks\/pretool\.js"$/);
  // No `shell` field on POSIX (only set on Windows).
  assert.equal(settings.hooks.BeforeTool[0].hooks[0].shell, undefined);
});

test("_writeSettingsFile writes valid JSON and returns absolute path", () => {
  const settings = { hooks: { BeforeTool: [{ matcher: "*", hooks: [] }] } };
  const file = adapter._writeSettingsFile(settings);
  try {
    assert.ok(fs.existsSync(file));
    const contents = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(contents, settings);
  } finally {
    adapter._cleanupFile(file);
    assert.equal(fs.existsSync(file), false);
  }
});

test("_cleanupFile is safe to call on missing/null paths", () => {
  // Should not throw.
  adapter._cleanupFile(null);
  adapter._cleanupFile(undefined);
  adapter._cleanupFile("/nonexistent/path");
});

test("buildSpawnExtras returns env with GEMINI_CLI_SYSTEM_SETTINGS_PATH + GEMINI_SYSTEM_MD + dialect flag", () => {
  const r = adapter.buildSpawnExtras({
    pluginDir: "/tmp/plugin",
    ipcSocketPath: "/tmp/gryphon.sock",
    nodePath: "/usr/bin/node",
  });
  try {
    assert.ok(r.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
    assert.equal(r.env.GRYPHON_PERMISSION_SOCKET, "/tmp/gryphon.sock");
    assert.equal(r.env.GRYPHON_HOOK_DIALECT, "gemini",
      "must tell hook scripts to emit Gemini's flat decision shape");
    assert.equal(r.env.GEMINI_SYSTEM_MD, r.instructionsFile,
      "GEMINI_SYSTEM_MD must point at our model-instructions file so the " +
      "model gets the anti-leak + compound-request directives at session start");
    assert.deepEqual(r.args, []);
    assert.ok(fs.existsSync(r.settingsFile));
    const written = JSON.parse(fs.readFileSync(r.settingsFile, "utf8"));
    assert.ok(written.hooks.BeforeTool, "settings file contains BeforeTool registration");
    assert.ok(fs.existsSync(r.instructionsFile));
    const md = fs.readFileSync(r.instructionsFile, "utf8");
    assert.match(md, /protected.pattern/i, "instructions reference the protected-pattern wording");
    assert.match(md, /COMPOUND REQUESTS/, "instructions include the compound-request rule");
  } finally {
    r.cleanup();
  }
});

test("QA-V13H-A: buildSpawnExtras rolls back the first file when the second write fails", () => {
  // Simulate the second tmpfile write throwing (disk full / EPERM /
  // antivirus). Without rollback, the settings.json from the first
  // successful write would leak in tmpdir — buildSpawnExtras throws
  // before returning the cleanup callback, so the caller has no way
  // to remove it.
  const realWrite = fs.writeFileSync;
  let calls = 0;
  let firstFile = null;
  fs.writeFileSync = function patched(p, ...rest) {
    calls += 1;
    if (calls === 1) {
      firstFile = p;
      return realWrite.call(fs, p, ...rest);
    }
    const err = new Error("simulated EIO during instructions write");
    err.code = "EIO";
    throw err;
  };
  try {
    assert.throws(() =>
      adapter.buildSpawnExtras({
        pluginDir: "/tmp/plugin",
        ipcSocketPath: "/tmp/gryphon.sock",
        nodePath: "/usr/bin/node",
      }),
    );
    assert.ok(firstFile, "first write recorded the settings path");
    assert.ok(!fs.existsSync(firstFile),
      `settings.json leaked after partial-write failure: ${firstFile}`);
  } finally {
    fs.writeFileSync = realWrite;
    if (firstFile && fs.existsSync(firstFile)) {
      try { fs.unlinkSync(firstFile); } catch (_) {}
    }
  }
});

test("buildSpawnExtras returns null when required inputs are missing", () => {
  assert.equal(adapter.buildSpawnExtras({}), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/x" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/x", ipcSocketPath: "/s" }), null);
});

test("GEMINI_HOOK_EVENTS table is consistent with HOOK_FILES", () => {
  const { HOOK_FILES } = require("../src/providers/claude-code/hook-settings-builder");
  const fileNames = adapter.GEMINI_HOOK_EVENTS.map(([, fn]) => fn);
  // Every entry in the table must reference a real script file.
  for (const fn of fileNames) {
    assert.ok(Object.values(HOOK_FILES).includes(fn),
      `${fn} not in HOOK_FILES — Stage 5 events must use the same script set`);
  }
});

// ─────────────────────────────────────────────────────────────────
// Hook script dialect support — pretool.js must emit Gemini's flat
// decision shape when GRYPHON_HOOK_DIALECT=gemini.
// ─────────────────────────────────────────────────────────────────

test("hooks/pretool.js source pins the dialect-aware buildDecision", () => {
  const src = fs.readFileSync(require.resolve("../hooks/pretool.js"), "utf8");
  assert.match(src, /GRYPHON_HOOK_DIALECT.*===.*"gemini"/,
    "pretool.js must check GRYPHON_HOOK_DIALECT to pick output shape");
  assert.match(src, /\bdecision:\s*geminiDecision\b/,
    "pretool.js must emit Gemini's flat {decision, reason} shape");
  assert.match(src, /hookSpecificOutput/,
    "pretool.js must still emit Claude/Codex's {hookSpecificOutput} shape for default dialect");
});
