// HookDispatcher API surface tests — covers the contract every
// provider relies on. We don't actually spawn anything; the
// dispatcher's job is to translate config + plugin state into spawn
// extras, and that's deterministic and unit-testable.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

// The dispatcher pulls in the claude-code adapter which transitively
// imports `obsidian` via permission-gate. Stub it.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const dispatcher = require("../src/providers/shared/hook-dispatcher");
const { listSupportedKinds, getAdapter } = require("../src/providers/shared/hook-adapters");

// ─────────────────────────────────────────────────────────────────
// Adapter registry shape
// ─────────────────────────────────────────────────────────────────

test("registry exposes claude-code, codex-cli, gemini-cli adapters", () => {
  assert.deepEqual(listSupportedKinds(), ["claude-code", "codex-cli", "gemini-cli"]);
});

test("each registered adapter declares its kind and has buildSpawnExtras", () => {
  for (const kind of listSupportedKinds()) {
    const a = getAdapter(kind);
    assert.equal(a.kind, kind);
    assert.equal(typeof a.buildSpawnExtras, "function");
  }
});

test("getAdapter for unknown kind returns null", () => {
  assert.equal(getAdapter("unknown-cli"), null);
});

// ─────────────────────────────────────────────────────────────────
// prepareSpawn pre-flight
// ─────────────────────────────────────────────────────────────────

function makePluginStub({
  protectedMode = true,
  ipcServer = { isListening: () => true, socketPath: () => "/tmp/gryphon-test.sock" },
  pluginDir = null,
} = {}) {
  return {
    settings: { protectedMode },
    ipcServer,
    absolutePluginDir: () => pluginDir,
  };
}

test("prepareSpawn returns degraded result when kind has no adapter", () => {
  const r = dispatcher.prepareSpawn({ kind: "fictional-cli", plugin: makePluginStub() });
  assert.equal(r.ok, false);
  assert.match(r.degradationReason, /no hook adapter/);
});

test("prepareSpawn returns degraded result when protectedMode is off", () => {
  const r = dispatcher.prepareSpawn({
    kind: "claude-code",
    plugin: makePluginStub({ protectedMode: false }),
  });
  assert.equal(r.ok, false);
  assert.match(r.degradationReason, /protectedMode is off/);
});

test("prepareSpawn returns degraded result when IPC server is not listening", () => {
  const r = dispatcher.prepareSpawn({
    kind: "claude-code",
    plugin: makePluginStub({
      ipcServer: { isListening: () => false, socketPath: () => "" },
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.degradationReason, /ipc server/i);
});

test("prepareSpawn returns degraded result when plugin dir not resolvable", () => {
  const r = dispatcher.prepareSpawn({
    kind: "claude-code",
    plugin: makePluginStub({ pluginDir: null }),
  });
  assert.equal(r.ok, false);
  assert.match(r.degradationReason, /plugin dir/i);
});

test("All three adapters (claude-code, codex-cli, gemini-cli) wire up via the dispatcher", () => {
  const realPluginDir = path.resolve(__dirname, "..");
  const hookDir = path.join(realPluginDir, "hooks");
  if (!fs.existsSync(path.join(hookDir, "pretool.js"))) return;

  // codex-cli — produces CODEX_HOME overlay
  const codex = dispatcher.prepareSpawn({
    kind: "codex-cli",
    plugin: makePluginStub({ pluginDir: realPluginDir }),
  });
  assert.equal(codex.ok, true);
  assert.ok(codex.env.CODEX_HOME);
  assert.ok(codex.env.GRYPHON_PERMISSION_SOCKET);
  assert.ok(fs.existsSync(codex.env.CODEX_HOME));
  assert.ok(fs.existsSync(path.join(codex.env.CODEX_HOME, "config.toml")));
  codex.cleanup();
  assert.equal(fs.existsSync(codex.env.CODEX_HOME), false);

  // gemini-cli — produces a tmp settings.json + dialect flag
  const gemini = dispatcher.prepareSpawn({
    kind: "gemini-cli",
    plugin: makePluginStub({ pluginDir: realPluginDir }),
  });
  assert.equal(gemini.ok, true);
  assert.ok(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
  assert.equal(gemini.env.GRYPHON_HOOK_DIALECT, "gemini");
  assert.ok(gemini.env.GRYPHON_PERMISSION_SOCKET);
  assert.ok(fs.existsSync(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));
  // Settings file must contain Gemini-flavored event names.
  const written = JSON.parse(fs.readFileSync(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
  assert.ok(written.hooks.BeforeTool, "Gemini settings.json must register BeforeTool");
  assert.equal(written.hooks.PreToolUse, undefined);
  gemini.cleanup();
  assert.equal(fs.existsSync(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH), false);
});

// ─────────────────────────────────────────────────────────────────
// preparePermissionsFallback
// ─────────────────────────────────────────────────────────────────

test("preparePermissionsFallback writes a permissions-only settings file for claude-code", () => {
  const result = dispatcher.preparePermissionsFallback({
    kind: "claude-code",
    plugin: makePluginStub({ pluginDir: "/tmp" }),
    denyGlobs: ["Bash(rm *)", "Bash(curl *)"],
  });
  assert.equal(result.ok, true);
  assert.ok(result.settingsFile);
  assert.ok(fs.existsSync(result.settingsFile), "settings file should exist on disk");
  const contents = JSON.parse(fs.readFileSync(result.settingsFile, "utf8"));
  assert.deepEqual(contents.permissions.deny, ["Bash(rm *)", "Bash(curl *)"]);
  // settings file shouldn't contain a hooks block (this is the fallback
  // path — see hook-settings-builder for why these can't coexist).
  assert.equal(contents.hooks, undefined);
  result.cleanup();
  assert.equal(fs.existsSync(result.settingsFile), false, "cleanup removes the file");
});

test("preparePermissionsFallback returns null for non-claude-code providers", () => {
  // Stage 1: only claude-code has a permissions-only fallback. Codex
  // and Gemini will get their own fallbacks if needed in later stages.
  const result = dispatcher.preparePermissionsFallback({
    kind: "codex-cli",
    plugin: makePluginStub({ pluginDir: "/tmp" }),
    denyGlobs: [],
  });
  assert.equal(result, null);
});
