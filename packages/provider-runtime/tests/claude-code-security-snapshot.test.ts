/**
 * Issue #29: the claude-code spawn takes its protection from the host's
 * security snapshot (`options.security`), never from the vault's data.json
 * (`plugin.settings`). Drives the real ClaudeCodeProvider.spawn() and
 * captures the argv handed to managedSpawn (same harness as
 * claude-code-vault-settings.test.ts).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const registryPath = require.resolve("../src/subprocess-registry");
const registry = require(registryPath);
const spawns: any[] = [];
require.cache[registryPath]!.exports = { ...registry, managedSpawn: fakeSpawn };
function fakeSpawn(cmd: string, args: string[], opts: any) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.pid = 0;
  spawns.push({ cmd, args, opts, proc });
  return proc;
}

const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
const { securitySettings } = require("@gryphon/protect");

const NO_USER_CONFIG = path.join(os.tmpdir(), "g29-no-such-claude.json");
const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), "g29-cc-vault-"));
// What a shared vault's data.json says.
const VAULT_SETTINGS = { protectedMode: false, permissionMode: "bypassPermissions", protectedCommandsEnabled: false };

function launch(options: Record<string, any>) {
  const provider = new ClaudeCodeProvider("/fake/claude", vault(), {
    plugin: { settings: VAULT_SETTINGS },
    hostAdapter: { notify() {} },
    _spawnOverride: () => Promise.resolve({}),
    _mcpApprovals: { lookup: () => null },
    _claudeUserConfigFile: NO_USER_CONFIG,
    ...options,
  });
  const n = spawns.length;
  const origErr = console.error;
  console.error = () => {};
  try { provider.spawn(); } finally { console.error = origErr; }
  return spawns.length > n ? (spawns[spawns.length - 1].args as string[]) : null;
}
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test("#29 (1): first spawn is protected — no bypass flag, deny list on — despite the vault's data.json", () => {
  const security = securitySettings.effectiveSecuritySettings(VAULT_SETTINGS, null);
  const args = launch({ permissionMode: security.permissionMode, security })!;
  assert.ok(args, "spawned");
  assert.equal(values(args, "--permission-mode").length, 0, "default mode passes no --permission-mode (i.e. default)");
  const [settingsFile] = values(args, "--settings");
  const deny: string[] = (JSON.parse(fs.readFileSync(settingsFile, "utf8")).permissions || {}).deny || [];
  assert.ok(deny.some((g) => /^Bash\(rm/.test(g)), `the protected-command deny list is on (no IPC → deny-glob fallback): ${deny.slice(0, 5).join(", ")}`);
});

test("#29 (2): a confirmed snapshot carries bypassPermissions", () => {
  const security = Object.freeze({ ...securitySettings.effectiveSecuritySettings({}, null), permissionMode: "bypassPermissions", protectedMode: false });
  const args = launch({ permissionMode: security.permissionMode, security })!;
  assert.deepEqual(values(args, "--permission-mode"), ["bypassPermissions"]);
});
