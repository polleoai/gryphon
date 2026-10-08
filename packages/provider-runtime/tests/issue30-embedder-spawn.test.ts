/**
 * Issue #30 acceptance A10 (provider half) + A11: an embedder-shaped embedder
 * — no IPC server, no `absolutePluginDir`, no `hooks/` on disk, Protected
 * Mode forced off by code — still
 *   - gets a claude-code spawn (deny globs, no hook wiring to a dead socket),
 *   - gets the store-guard hook on codex / gemini / antigravity spawns,
 * and every `securityInputsOf` call on those paths carries the spawn's
 * `security` snapshot (G4: no site falls back to plugin.settings).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const POSIX = process.platform !== "win32";
process.env.XDG_CONFIG_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-ae-cfg-")));
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-ae-home-")));
process.env.HOME = fakeHome;

// Spy on securityInputsOf BEFORE anything destructures it.
const storePath = require.resolve(path.join(__dirname, "..", "..", "protect", "dist", "security-settings-store"));
const storeMod = require(storePath);
const calls: any[] = [];
const realInputsOf = storeMod.securityInputsOf;
storeMod.securityInputsOf = (holder: any) => { calls.push(holder); return realInputsOf(holder); };

const registryPath = require.resolve("../src/subprocess-registry");
const registry = require(registryPath);
const spawns: any[] = [];
require.cache[registryPath]!.exports = { ...registry, managedSpawn: fakeSpawn };
function fakeSpawn(cmd: string, args: string[], opts: any) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  // No pid: a tree-kill of pid 0 would signal this test's own process group.
  proc.pid = undefined;
  proc.kill = () => {};
  spawns.push({ cmd, args, opts, proc });
  return proc;
}

const { securitySettings } = require("@gryphon/protect");
const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-ae-vault-")));
const embedder = {
  app: { vault: { adapter: { getBasePath: () => vault } } },
  settings: { protectedMode: true },
  // no ipcServer, no absolutePluginDir, no hooks/
};
const EMBEDDER_OVERRIDES = { protectedMode: false };
const security = securitySettings.effectiveSecuritySettings(embedder.settings, { vaultKey: vault, hostId: "embedder" }, EMBEDDER_OVERRIDES);

test("#30 A11: embedder-shaped claude-code turn spawns with no IPC server; every securityInputsOf call has `security`", () => {
  const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
  calls.length = 0;
  const p = new ClaudeCodeProvider("/fake/claude", vault, {
    plugin: embedder, security, permissionMode: security.permissionMode,
    hostAdapter: { notify() {} },
    _spawnOverride: () => Promise.resolve({}),
    _mcpApprovals: { lookup: () => null },
    _claudeUserConfigFile: path.join(os.tmpdir(), "g30-no-such-claude.json"),
  });
  const n = spawns.length;
  const oe = console.error; console.error = () => {};
  try { p.spawn(); } finally { console.error = oe; }
  assert.ok(spawns.length > n, "claude-code spawned");
  const args: string[] = spawns[spawns.length - 1].args;
  const settingsFile = args[args.indexOf("--settings") + 1];
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.hooks, undefined, "no hooks wired to a dead socket");
  assert.ok((settings.permissions?.deny || []).some((g: string) => /gryphon/.test(g)), "store deny globs present");
  assert.ok(calls.length > 0, "securityInputsOf was consulted");
  for (const h of calls) assert.ok(h && h.security, "a securityInputsOf call lacked `security`");
});

for (const [kind, mod, cls] of [
  ["codex-cli", "../src/providers/codex-cli/codex-cli", "CodexProvider"],
  ["gemini-cli", "../src/providers/gemini-cli/gemini-cli", "GeminiCliProvider"],
  ["antigravity-cli", "../src/providers/antigravity-cli/antigravity-cli", "AntigravityCliProvider"],
] as Array<[string, string, string]>) {
  test(`#30 A10: embedder-shaped ${kind} spawn gets the store-guard hook (no IPC, no plugin dir)`, { skip: !POSIX }, async () => {
    const Provider = require(mod)[cls];
    calls.length = 0;
    // A real executable so the spawn-time `--version` check passes; the
    // spawn itself goes to fakeSpawn.
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "g30-ae-bin-")), kind);
    fs.writeFileSync(bin, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
    const p = new Provider(bin, vault, {
      plugin: embedder, security, permissionMode: "bypassPermissions",
      hostAdapter: { notify() {} },
    });
    const n = spawns.length;
    const oe = console.error; const ow = console.warn;
    console.error = () => {}; console.warn = () => {};
    try {
      const turn = p.send("hi").catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(spawns.length > n, `${kind} spawned`);
      const { args, opts } = spawns[spawns.length - 1];
      let cfg = "";
      if (kind === "codex-cli") cfg = fs.readFileSync(path.join(opts.env.CODEX_HOME, "config.toml"), "utf8");
      if (kind === "gemini-cli") cfg = fs.readFileSync(opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8");
      if (kind === "antigravity-cli") {
        cfg = fs.readFileSync(path.join(fakeHome, ".gemini", "config", "hooks.json"), "utf8");
        assert.ok(args.includes("--dangerously-skip-permissions"), "Protected Mode off keeps auto-approve");
      }
      assert.match(cfg, /store-guard-[0-9a-f]{16}\.js/, `${kind}: hook points at the materialized store guard`);
      for (const h of calls) assert.ok(h && h.security, "a securityInputsOf call lacked `security`");
      // Clean up the installed hook config without killing anything.
      try { p._hookCleanup?.(); } catch { /* best effort */ }
      void turn;
    } finally { console.error = oe; console.warn = ow; }
  });
}
