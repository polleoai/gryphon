/**
 * Hook settings builder tests (v0.6.0 Stage 3).
 *
 * Verifies the JSON Gryphon writes to `--settings <path>` has the
 * shape CC expects. We can't exercise CC itself in unit tests, so
 * these pin the wire format. If CC's schema changes in the future,
 * these tests will break loudly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const {
  buildHookSettings,
  buildPermissionsOnlySettings,
  writeHookSettingsFile,
  DEFAULT_HOOK_TIMEOUTS,
  HOOK_FILES,
  POSTTOOL_MATCHER,
} = require("../src/providers/claude-code/hook-settings-builder");

const EXAMPLE_PLUGIN_DIR = "/Users/test/vault/.obsidian/plugins/gryphon";
const EXAMPLE_SOCKET = path.join(os.tmpdir(), "gryphon-test.sock");
const EXAMPLE_NODE = "/usr/local/bin/node";

// ── shape ──────────────────────────────────────────────────────────────

test("buildHookSettings returns a hooks object with all 6 hook events", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
    nodePath: EXAMPLE_NODE,
  });
  assert.ok(out.hooks, "expected top-level `hooks` key");
  const expected = [
    "PreToolUse", "PostToolUse", "SessionStart",
    "SessionEnd", "UserPromptSubmit", "Notification",
  ];
  for (const event of expected) {
    assert.ok(out.hooks[event], `missing hook event ${event}`);
    assert.ok(Array.isArray(out.hooks[event]), `${event} should be an array`);
    assert.equal(out.hooks[event].length, 1, `${event} should have exactly one matcher entry`);
  }
});

test("each hook entry has matcher + hooks[] with command/timeout", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  for (const event of Object.keys(HOOK_FILES)) {
    const [entry] = out.hooks[event];
    assert.equal(typeof entry.matcher, "string");
    assert.ok(Array.isArray(entry.hooks));
    const [hook] = entry.hooks;
    assert.equal(hook.type, "command");
    assert.equal(typeof hook.command, "string");
    assert.equal(typeof hook.timeout, "number");
    assert.ok(hook.timeout > 0, `${event} timeout must be positive`);
  }
});

test("PreToolUse matches all tools (empty matcher)", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  assert.equal(out.hooks.PreToolUse[0].matcher, "");
});

test("PostToolUse matcher covers content-producing AND provenance-relevant tools", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  const matcher = out.hooks.PostToolUse[0].matcher;
  assert.equal(matcher, POSTTOOL_MATCHER);
  // v0.6.0-final: Edit is excluded — edits are user-intended changes
  // to existing files, not arriving untrusted content.
  assert.ok(!matcher.includes("Edit"), `PostToolUse should NOT include Edit: ${matcher}`);
  // Write MUST be included so provenance_add can run when a WebFetch
  // session is currently untrustedContentActive (bug found during
  // Stage-8 QA: without Write in the matcher, the Write branch of
  // posttool.js is dead code and no tags ever persist).
  // Framing is still skipped for Write inside posttool.js (shouldFrame
  // returns false) — the hook runs only for its provenance side effect.
  assert.ok(matcher.includes("Write"), `PostToolUse MUST include Write: ${matcher}`);
  for (const tool of ["WebFetch", "WebSearch", "Bash", "Read", "Glob", "Grep"]) {
    assert.ok(matcher.includes(tool), `PostToolUse matcher should include ${tool}`);
  }
});

// ── command format ─────────────────────────────────────────────────────

test("command string quotes both the node binary and the hook script path", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
    nodePath: EXAMPLE_NODE,
  });
  const cmd = out.hooks.PreToolUse[0].hooks[0].command;
  // JSON.stringify renders paths with surrounding double quotes — that's
  // shell-safe for any path our users are likely to have.
  assert.ok(cmd.startsWith(`"${EXAMPLE_NODE}"`), `expected node path quoted: ${cmd}`);
  assert.ok(cmd.includes(`"${path.join(EXAMPLE_PLUGIN_DIR, "hooks", "pretool.js")}"`), cmd);
});

test("paths with spaces are safely quoted", () => {
  const spacyDir = "/Users/Bob Smith/vault with space/.obsidian/plugins/gryphon";
  const out = buildHookSettings({
    pluginDir: spacyDir,
    socketPath: EXAMPLE_SOCKET,
  });
  const cmd = out.hooks.PreToolUse[0].hooks[0].command;
  // The user's path appears wrapped in quotes so `sh -c` parses it as
  // a single argument rather than splitting on the spaces.
  assert.ok(cmd.includes(`"${path.join(spacyDir, "hooks", "pretool.js")}"`), cmd);
});

test("on POSIX, hook entries do NOT set the `shell` field", () => {
  // Default is bash — omitting is correct and keeps the settings file
  // tight. This also shields us from a future CC release that might
  // reject unknown `shell` values.
  if (process.platform === "win32") return;
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  for (const event of Object.keys(HOOK_FILES)) {
    const [hook] = out.hooks[event][0].hooks;
    assert.equal(hook.shell, undefined, `POSIX ${event} must not set shell`);
  }
});

// ── Windows-specific shape ────────────────────────────────────────────

test("on Windows, command uses PowerShell call syntax and sets shell:powershell", () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const out = buildHookSettings({
      pluginDir: "C:\\Users\\test\\vault\\.obsidian\\plugins\\gryphon",
      socketPath: "\\\\.\\pipe\\gryphon-test",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    for (const event of Object.keys(HOOK_FILES)) {
      const [hook] = out.hooks[event][0].hooks;
      assert.equal(
        hook.shell, "powershell",
        `Windows ${event} must set shell:powershell so CC bypasses Git Bash`,
      );
      assert.ok(
        hook.command.startsWith("& '"),
        `Windows ${event} command must start with PowerShell call operator and single-quoted path: ${hook.command}`,
      );
      assert.ok(
        hook.command.includes("node.exe"),
        `Windows ${event} command must reference node.exe: ${hook.command}`,
      );
      assert.ok(
        hook.command.includes(HOOK_FILES[event]),
        `Windows ${event} command must reference ${HOOK_FILES[event]}: ${hook.command}`,
      );
      // MSYS2/POSIX path form (e.g. /c/Users/...) caused the
      // silent-hook-failure bug that shell:powershell fixes.
      // Guard against a future regression that reintroduces it.
      assert.ok(
        !/['\s]\/[A-Za-z]\//.test(hook.command),
        `Windows ${event} command must not contain MSYS2 POSIX path form: ${hook.command}`,
      );
      // Double quotes inside our command would collide with the outer
      // double quotes CC wraps around the command when invoking
      // powershell.exe -Command "<our-string>", causing silent hook
      // failure. Guard against regression.
      assert.ok(
        !hook.command.includes('"'),
        `Windows ${event} command must not contain double quotes: ${hook.command}`,
      );
    }
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform });
  }
});

test("on Windows, command quotes paths so spaces in 'Program Files' are preserved", () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const out = buildHookSettings({
      pluginDir: "C:\\Users\\Bob Smith\\gryphon",
      socketPath: "\\\\.\\pipe\\gryphon-test",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    const cmd = out.hooks.PreToolUse[0].hooks[0].command;
    // Both paths must be wrapped in PowerShell single-quotes for the
    // `&` call operator to treat them as single literal tokens. Single
    // quotes (not double) because CC wraps the whole command in its
    // own double-quoted -Command arg.
    assert.ok(
      cmd.includes("'C:\\Program Files\\nodejs\\node.exe'"),
      `node path must be single-quoted: ${cmd}`,
    );
    assert.ok(
      cmd.includes("'C:\\Users\\Bob Smith\\gryphon"),
      `script path must be single-quoted: ${cmd}`,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform });
  }
});

test("each hook points at its expected script file", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  for (const [event, script] of Object.entries(HOOK_FILES)) {
    const cmd = out.hooks[event][0].hooks[0].command;
    assert.ok(
      cmd.includes(path.join("hooks", script)),
      `${event} command should reference ${script}, got: ${cmd}`
    );
  }
});

// ── timeouts ──────────────────────────────────────────────────────────

test("default timeouts match the design doc values", () => {
  // Pin the numbers so tuning them is an explicit decision.
  // PreToolUse is long because the modal may sit waiting for the user.
  assert.equal(DEFAULT_HOOK_TIMEOUTS.PreToolUse, 300);
  assert.equal(DEFAULT_HOOK_TIMEOUTS.PostToolUse, 10);
  assert.equal(DEFAULT_HOOK_TIMEOUTS.SessionStart, 10);
  assert.equal(DEFAULT_HOOK_TIMEOUTS.SessionEnd, 5);
  assert.equal(DEFAULT_HOOK_TIMEOUTS.UserPromptSubmit, 10);
  assert.equal(DEFAULT_HOOK_TIMEOUTS.Notification, 2);
});

test("caller can override timeouts", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
    timeouts: { PreToolUse: 999 },
  });
  assert.equal(out.hooks.PreToolUse[0].hooks[0].timeout, 999);
  // Non-overridden events keep their default.
  assert.equal(
    out.hooks.PostToolUse[0].hooks[0].timeout,
    DEFAULT_HOOK_TIMEOUTS.PostToolUse,
  );
});

// ── input validation ──────────────────────────────────────────────────

test("buildHookSettings rejects missing pluginDir", () => {
  assert.throws(
    () => buildHookSettings({ socketPath: EXAMPLE_SOCKET }),
    /pluginDir/,
  );
});

test("buildHookSettings rejects missing socketPath", () => {
  assert.throws(
    () => buildHookSettings({ pluginDir: EXAMPLE_PLUGIN_DIR }),
    /socketPath/,
  );
});

test("buildHookSettings rejects non-string pluginDir", () => {
  assert.throws(
    () => buildHookSettings({ pluginDir: 123, socketPath: EXAMPLE_SOCKET }),
    /pluginDir/,
  );
});

// ── writeHookSettingsFile ─────────────────────────────────────────────

test("writeHookSettingsFile writes valid JSON readable by CC", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  const filePath = writeHookSettingsFile(out);
  try {
    assert.ok(fs.existsSync(filePath), "settings file should exist after write");
    assert.ok(filePath.startsWith(os.tmpdir()), "file should be in tmpdir");
    assert.ok(filePath.endsWith(".json"), "file should have .json suffix");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    // Round-trip equality on structure.
    assert.deepEqual(Object.keys(parsed.hooks).sort(), Object.keys(out.hooks).sort());
    for (const event of Object.keys(out.hooks)) {
      assert.deepEqual(parsed.hooks[event], out.hooks[event]);
    }
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

test("writeHookSettingsFile produces unique filenames across calls", () => {
  const out = buildHookSettings({
    pluginDir: EXAMPLE_PLUGIN_DIR,
    socketPath: EXAMPLE_SOCKET,
  });
  const a = writeHookSettingsFile(out);
  const b = writeHookSettingsFile(out);
  try {
    assert.notEqual(a, b, "consecutive writes should produce different paths");
  } finally {
    if (fs.existsSync(a)) fs.unlinkSync(a);
    if (fs.existsSync(b)) fs.unlinkSync(b);
  }
});

// ── buildPermissionsOnlySettings (fallback-mode deny-list) ─────────────

test("buildPermissionsOnlySettings returns permissions.deny with given rules", () => {
  const rules = ["Bash(rm -rf*)", "Write(.env)", "Edit(secrets.json)"];
  const out = buildPermissionsOnlySettings(rules);
  assert.deepEqual(Object.keys(out), ["permissions"]);
  assert.deepEqual(out.permissions, { deny: rules });
});

test("buildPermissionsOnlySettings omits non-string / empty entries", () => {
  const out = buildPermissionsOnlySettings([
    "Bash(rm *)",
    "",            // empty string — dropped
    null,          // not a string — dropped
    undefined,     // not a string — dropped
    42,            // not a string — dropped
    "Write(.git/**)",
  ]);
  assert.deepEqual(out.permissions.deny, ["Bash(rm *)", "Write(.git/**)"]);
});

test("buildPermissionsOnlySettings handles non-array input as empty", () => {
  assert.deepEqual(buildPermissionsOnlySettings(undefined).permissions.deny, []);
  assert.deepEqual(buildPermissionsOnlySettings(null).permissions.deny, []);
  assert.deepEqual(buildPermissionsOnlySettings("nope").permissions.deny, []);
});

test("buildPermissionsOnlySettings MUST NOT include a hooks block", () => {
  // CC's PreToolUse hook dispatches AFTER permissions.deny. If we ever
  // accidentally mixed the two in fallback mode, the approval modal
  // would be silently short-circuited for every rule the user had set.
  const out = buildPermissionsOnlySettings(["Bash(rm *)"]);
  assert.equal(out.hooks, undefined, "fallback settings must not carry hooks");
});

test("buildPermissionsOnlySettings output round-trips through writeHookSettingsFile", () => {
  const out = buildPermissionsOnlySettings(["Bash(rm -rf*)", "Write(.env)"]);
  const filePath = writeHookSettingsFile(out);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, out);
    assert.equal(parsed.hooks, undefined);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

