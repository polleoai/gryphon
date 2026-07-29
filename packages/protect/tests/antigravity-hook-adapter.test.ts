// Antigravity CLI hook adapter — hooks.json shape, global-file merge
// semantics, cleanup, and self-heal.
//
// Antigravity is the ONLY provider whose hook config cannot be isolated to
// a Gryphon-owned temp file: `agy` discovers hooks solely from the
// user-global `~/.gemini/config/hooks.json` (verified live against agy
// v1.1.8 — a workspace `.agents/hooks.json` in the spawn cwd loads 0 hook
// files, with or without a VCS root, and no env var redirects the
// customization root). So this adapter MERGES one named key into a file the
// user also owns, and must never clobber or delete their entries.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const adapter = require("../src/hook-adapters/antigravity-cli");

// Redirect the adapter at a scratch hooks.json so tests never touch the
// real ~/.gemini/config.
function withTempHooksFile(fn: any, seed?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-agy-hooks-"));
  const file = path.join(dir, "hooks.json");
  if (seed !== undefined) fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (f: any) => JSON.parse(fs.readFileSync(f, "utf8"));

test("kind is 'antigravity-cli'", () => {
  assert.equal(adapter.kind, "antigravity-cli");
});

test("hooks file path resolves under the global Antigravity customization root", () => {
  // Not a temp file: agy only reads this one location.
  assert.equal(adapter.hooksFilePath(), path.join(os.homedir(), ".gemini", "config", "hooks.json"));
});

test("_buildHookEntry registers PreToolUse with a match-all matcher", () => {
  const entry = adapter._buildHookEntry({ pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
  assert.ok(Array.isArray(entry.PreToolUse), "PreToolUse must be present — it is the enforcement gate");
  const group = entry.PreToolUse[0];
  assert.equal(group.matcher, "*", "must gate every tool, not just run_command");
  assert.equal(group.hooks[0].type, "command");
  assert.match(group.hooks[0].command, /pretool/);
});

test("_buildHookEntry sets timeout in SECONDS (Antigravity is seconds, unlike Gemini's ms)", () => {
  // Gemini's adapter multiplies by 1000 because Gemini reads this field as
  // milliseconds; Antigravity's embedded docs say "Execution timeout in
  // seconds. Defaults to 30." Copying Gemini's *1000 here would give a
  // ~3.5-day timeout; copying nothing would give 30s — far below the
  // user's think-time on the approve/deny modal, which is the exact
  // default-allow bug reported against Gemini on 2026-05-03.
  const entry = adapter._buildHookEntry({ pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
  const timeout = entry.PreToolUse[0].hooks[0].timeout;
  assert.equal(typeof timeout, "number");
  assert.ok(timeout >= 120 && timeout <= 600,
    `expected a seconds-scale timeout with room for user think-time, got ${timeout}`);
});

test("the hook command carries Gryphon's env inline, not via spawn inheritance", () => {
  // Verified live: when GRYPHON_HOOK_DIALECT does not reach the hook
  // process, pretool.js emits Claude-shaped output, Antigravity cannot read
  // a decision from it, and it RUNS THE TOOL. The guardrail degrades to
  // silent-allow with no error logged anywhere. Baking the env into the
  // command removes that dependency entirely.
  const entry = adapter._buildHookEntry({
    pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node", ipcSocketPath: "/tmp/gryphon.sock",
  });
  const cmd = entry.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /GRYPHON_HOOK_DIALECT=.?antigravity/,
    "without the dialect the output shape is wrong and agy silently allows");
  assert.match(cmd, /GRYPHON_PERMISSION_SOCKET=.?\/tmp\/gryphon\.sock/);
  assert.match(cmd, /GRYPHON_HOOK_PROVIDER=.?antigravity-cli/);
  assert.ok(cmd.indexOf("pretool") > cmd.indexOf("GRYPHON_HOOK_DIALECT"),
    "assignments must precede the interpreter invocation");
});

// ── Merge semantics: the file is shared with the user ────────────────────

test("install() creates the file when absent", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.ok(json[adapter.HOOK_KEY], "gryphon key written");
    assert.ok(json[adapter.HOOK_KEY].PreToolUse);
  });
});

test("install() preserves the user's own hook entries", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.deepEqual(json["user-linter"], { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] },
      "a user's existing named hook must survive untouched");
    assert.ok(json[adapter.HOOK_KEY], "and ours is added alongside");
  }, { "user-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } });
});

test("uninstall() removes ONLY the gryphon key, leaving the user's file intact", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._uninstallFrom(file);
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY], undefined, "our key is gone");
    assert.ok(json["user-linter"], "the user's key must NOT be collateral damage");
  }, { "user-linter": { PostToolUse: [] } });
});

test("uninstall() removes the file entirely when Gryphon's key was the only content", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._uninstallFrom(file);
    assert.equal(fs.existsSync(file), false,
      "leaving an empty {} behind would be litter in the user's global config");
  });
});

test("uninstall() on an absent file is a no-op, not a throw", () => {
  withTempHooksFile((file: any) => {
    assert.doesNotThrow(() => adapter._uninstallFrom(file));
  });
});

test("install() is idempotent — a second install does not duplicate handlers", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY].PreToolUse.length, 1);
    assert.equal(json[adapter.HOOK_KEY].PreToolUse[0].hooks.length, 1);
  });
});

// ── Self-heal: a crashed Gryphon must not gate the user's own agy ────────

test("self-heal strips a stale gryphon key left behind by a crash", () => {
  withTempHooksFile((file: any) => {
    const stripped = adapter._stripStaleFrom(file);
    assert.equal(stripped, true, "reports that it healed something");
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY], undefined,
      "a stale key would silently gate the user's own interactive `agy` on every tool call");
    assert.ok(json["user-linter"], "user entries survive the heal");
  }, {
    "user-linter": { PostToolUse: [] },
    [adapter.HOOK_KEY]: { PreToolUse: [{ matcher: "*", hooks: [{ command: "/stale/pretool.js" }] }] },
  });
});

test("self-heal reports false when there is nothing to clean", () => {
  withTempHooksFile((file: any) => {
    assert.equal(adapter._stripStaleFrom(file), false);
  }, { "user-linter": { PostToolUse: [] } });
});

test("a corrupt hooks.json does not throw and does not destroy the user's file", () => {
  withTempHooksFile((file: any) => {
    fs.writeFileSync(file, "{ this is not json");
    // Must fail soft: we cannot safely merge into a file we cannot parse,
    // and silently overwriting it would destroy the user's config.
    assert.doesNotThrow(() => adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" }));
    assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json",
      "the unparseable file is left exactly as found");
  });
});

// ── Spawn extras ─────────────────────────────────────────────────────────

test("buildSpawnExtras sets the antigravity dialect and the IPC socket", () => {
  const extras = adapter.buildSpawnExtras({
    pluginDir: "/tmp/plugin",
    ipcSocketPath: "/tmp/sock",
    nodePath: "/usr/bin/node",
    _hooksFile: withTempHooksFile((f: any) => f),  // path only; file removed
  });
  assert.equal(extras.env.GRYPHON_HOOK_DIALECT, "antigravity",
    "pretool.js needs this to parse camelCase toolCall payloads and emit decision/reason");
  assert.equal(extras.env.GRYPHON_PERMISSION_SOCKET, "/tmp/sock");
  assert.equal(extras.env.GRYPHON_HOOK_PROVIDER, "antigravity-cli");
  assert.equal(typeof extras.cleanup, "function");
  extras.cleanup();
});

test("buildSpawnExtras returns null when a required input is missing", () => {
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "", ipcSocketPath: "/tmp/s", nodePath: "/n" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/p", ipcSocketPath: "", nodePath: "/n" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/p", ipcSocketPath: "/tmp/s", nodePath: "" }), null);
});

test("adapter is registered in the dispatcher registry", () => {
  const { getAdapter, listSupportedKinds } = require("../src/hook-adapters/index");
  assert.ok(getAdapter("antigravity-cli"), "dispatcher must resolve the kind, else prepareSpawn degrades");
  assert.ok(listSupportedKinds().includes("antigravity-cli"));
});
