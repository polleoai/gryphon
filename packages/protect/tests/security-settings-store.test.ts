/**
 * Issue #29 acceptance (unit): the machine-local security-settings store.
 *
 * A vault's data.json travels with the vault, so its weakening values
 * (protectedMode:false, permissionMode:"bypassPermissions", …) are never
 * enforcement inputs. effective = securityOverrides ?? store[vault][host] ?? DEFAULT.
 *
 * Items: 5 (unit half), 7 (unit half), 8, 9, 12, 15 (unit half), 18, plus
 * scope derivation (rev 3 R1) and enforcement reading the snapshot.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const protect = require("../src/index");
const store = require("../src/security-settings-store");
const { classify } = require("../src/attack-detector");
const { checkPermission } = require("../src/permission-gate");
const { buildDisallowedTools, buildApprovalsStoreDenyGlobs } = require("../src/cc-disallow-translator");

function freshConfigHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g29-cfg-")));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}
function vaultDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g29-vault-")));
}
function appFor(basePath: string | null) {
  return { vault: { adapter: { getBasePath: () => basePath, basePath } }, workspace: { trigger() {} } };
}
function captureErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => { errors.push(a.map(String).join(" ")); };
  try { return { result: fn(), errors }; } finally { console.error = orig; }
}

const VAULT_WEAK = {
  protectedMode: false,
  permissionMode: "bypassPermissions",
  protectedPathsDisabled: [".obsidian/plugins/gryphon/"],
};

// ── exports + closed key set ────────────────────────────────────────────

test("#29: @gryphon/protect exports the store API", () => {
  for (const k of ["WEAKENING_KEYS", "SecurityScopeUnavailableError", "resolveSecurityScope", "readMachineSecuritySettings",
    "setMachineSecuritySetting", "dismissVaultSecuritySuggestion", "isWeakening", "effectiveSecuritySettings"]) {
    assert.ok(protect[k], `missing export ${k}`);
  }
  assert.deepEqual([...protect.WEAKENING_KEYS].sort(), [
    "blockPackageInstall", "claudeCodeInheritUserConfig", "obsidianRestApiPolicy", "permissionMode",
    "protectedCommandsDisabled", "protectedCommandsEnabled", "protectedMode", "protectedPathsDisabled", "protectedPathsEnabled",
  ]);
});

test("#29 (18): autoDenyProtected is not a weakening key", () => {
  assert.ok(!store.WEAKENING_KEYS.includes("autoDenyProtected"));
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  assert.throws(() => store.setMachineSecuritySetting(scope, "autoDenyProtected", true), /unknown key/);
  // It stays a data.json preference: copied into the snapshot as-is, never unconfirmed.
  const eff = store.effectiveSecuritySettings({ autoDenyProtected: false }, scope);
  assert.equal(eff.autoDenyProtected, false);
  assert.ok(!eff.unconfirmed.includes("autoDenyProtected"));
  assert.equal(store.effectiveSecuritySettings({ autoDenyProtected: true }, scope).autoDenyProtected, true);
});

test("#29: isWeakening per key", () => {
  assert.equal(store.isWeakening("protectedMode", false), true);
  assert.equal(store.isWeakening("protectedMode", true), false);
  assert.equal(store.isWeakening("permissionMode", "bypassPermissions"), true);
  assert.equal(store.isWeakening("permissionMode", "default"), false);
  assert.equal(store.isWeakening("protectedPathsDisabled", [".obsidian/plugins/gryphon/"]), true);
  assert.equal(store.isWeakening("protectedPathsDisabled", []), false);
  assert.equal(store.isWeakening("claudeCodeInheritUserConfig", true), true);
  assert.equal(store.isWeakening("obsidianRestApiPolicy", "allowed"), true);
  assert.equal(store.isWeakening("obsidianRestApiPolicy", "blocked"), false);
});

// ── scope (rev 3 R1) ────────────────────────────────────────────────────

test("#29 (13): scope comes from app.vault.adapter + a code-set host id, never _vaultRoot()", () => {
  const v = vaultDir();
  let vaultRootCalled = false;
  // #30 (G3): the code-set securityHostId, never manifest.id.
  const host = { settings: {}, saveSettings() {}, app: appFor(v), securityHostId: "host-b", manifest: { id: "manifest-id" }, _vaultRoot() { vaultRootCalled = true; return "/elsewhere"; } };
  assert.deepEqual(store.resolveSecurityScope({ hostPlugin: host }), { vaultKey: v, hostId: "host-b" });
  assert.equal(vaultRootCalled, false);
  // An explicit hostId (options bag) wins; a view's app wins over the host's.
  const other = vaultDir();
  assert.deepEqual(store.resolveSecurityScope({ app: appFor(other), hostPlugin: host, hostId: "fixture" }), { vaultKey: other, hostId: "fixture" });
});

test("#29 (14): no app / no base path / no host id → no scope, and why", () => {
  assert.equal(store.resolveSecurityScope({ hostPlugin: { settings: {} } }), null);
  assert.equal(store.describeSecurityScope({ hostPlugin: { settings: {} } }).missing, "app");
  assert.equal(store.describeSecurityScope({ hostPlugin: { settings: {}, app: appFor(null), manifest: { id: "x" } } }).missing, "basePath");
  assert.equal(store.describeSecurityScope({ hostPlugin: { settings: {}, app: appFor(vaultDir()) } }).missing, "hostId");
  // Reads fail closed: every weakening key is its protected default.
  const eff = store.effectiveSecuritySettings(VAULT_WEAK, null);
  assert.equal(eff.protectedMode, true);
  assert.equal(eff.permissionMode, "default");
  assert.deepEqual([...eff.protectedPathsDisabled], []);
  assert.equal(eff.scopeAvailable, false);
  assert.equal(eff.source.permissionMode, "default");
});

// ── resolution (item 9) + data.json is never an input (item 5) ──────────

test("#29 (5): a vault's weakening data.json values start protected and are listed as unconfirmed", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  const eff = store.effectiveSecuritySettings(VAULT_WEAK, scope);
  assert.equal(eff.protectedMode, true);
  assert.equal(eff.permissionMode, "default");
  assert.deepEqual([...eff.protectedPathsDisabled], []);
  assert.deepEqual([...eff.unconfirmed].sort(), ["permissionMode", "protectedMode", "protectedPathsDisabled"]);
  assert.ok(Object.isFrozen(eff), "the snapshot is frozen");
});

test("#29 (5): after confirming on this machine they apply; a copied vault path asks again", () => {
  freshConfigHome();
  const v = vaultDir();
  const scope = { vaultKey: v, hostId: "gryphon" };
  for (const [k, val] of Object.entries(VAULT_WEAK)) store.setMachineSecuritySetting(scope, k, val);
  const eff = store.effectiveSecuritySettings(VAULT_WEAK, scope);
  assert.equal(eff.protectedMode, false);
  assert.equal(eff.permissionMode, "bypassPermissions");
  assert.deepEqual([...eff.unconfirmed], []);
  assert.equal(eff.source.permissionMode, "machine");
  // Copy of the vault: different realpath → different vaultKey → protected + prompts.
  const copy = vaultDir();
  const effCopy = store.effectiveSecuritySettings(VAULT_WEAK, store.resolveSecurityScope({ hostPlugin: { app: appFor(copy), securityHostId: "gryphon" } }));
  assert.equal(effCopy.permissionMode, "default");
  assert.equal(effCopy.unconfirmed.length, 3);
});

test("#29 (9): precedence override > store > DEFAULT; unconfirmed excludes overridden keys", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "host-b" };
  store.setMachineSecuritySetting(scope, "permissionMode", "acceptEdits");
  const overrides = { protectedMode: false, permissionMode: "plan" };
  const eff = store.effectiveSecuritySettings({ protectedMode: false, permissionMode: "bypassPermissions", blockPackageInstall: false }, scope, overrides);
  assert.equal(eff.permissionMode, "plan");
  assert.equal(eff.source.permissionMode, "override");
  assert.equal(eff.protectedMode, false);
  assert.equal(eff.source.protectedMode, "override");
  assert.equal(eff.blockPackageInstall, true);
  assert.equal(eff.source.blockPackageInstall, "default");
  assert.deepEqual([...eff.unconfirmed], ["blockPackageInstall"]);
  // Without the override, the store wins over DEFAULT.
  assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "acceptEdits");
});

test("#29: turning protection back on writes the store (a stale weaker value can't keep winning)", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  store.setMachineSecuritySetting(scope, "protectedMode", false);
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  assert.equal(store.readMachineSecuritySettings(scope).protectedMode, true);
  assert.equal(store.effectiveSecuritySettings({ protectedMode: false }, scope).protectedMode, true);
});

// ── dismiss (item 7) ────────────────────────────────────────────────────

test("#29 (7): 'Keep protections on' is quiet until data.json brings a different value", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  store.dismissVaultSecuritySuggestion(scope, "permissionMode", "bypassPermissions");
  const eff = store.effectiveSecuritySettings({ permissionMode: "bypassPermissions" }, scope);
  assert.equal(eff.permissionMode, "default");
  assert.deepEqual([...eff.unconfirmed], []);
  assert.deepEqual([...store.effectiveSecuritySettings({ permissionMode: "acceptEdits" }, scope).unconfirmed], ["permissionMode"]);
});

test("#29 (7): dismissing a list with a stale entry sticks (hashed after normalizing)", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  const fromFile = [".obsidian/plugins/gryphon/", "removed-in-a-later-version/"];
  store.dismissVaultSecuritySuggestion(scope, "protectedPathsDisabled", fromFile);
  assert.deepEqual([...store.effectiveSecuritySettings({ protectedPathsDisabled: fromFile }, scope).unconfirmed], []);
});

// ── per-host isolation (item 15) ────────────────────────────────────────

test("#29 (15): two hosts in one vault never share values or confirmations", () => {
  freshConfigHome();
  const v = vaultDir();
  const g = { vaultKey: v, hostId: "gryphon" };
  const a = { vaultKey: v, hostId: "other-fixture" };
  store.setMachineSecuritySetting(g, "permissionMode", "bypassPermissions");
  assert.equal(store.effectiveSecuritySettings({ permissionMode: "bypassPermissions" }, g).permissionMode, "bypassPermissions");
  const effA = store.effectiveSecuritySettings({ permissionMode: "acceptEdits" }, a);
  assert.equal(effA.permissionMode, "default");
  assert.deepEqual([...effA.unconfirmed], ["permissionMode"]);
});

// ── store file (item 8) ─────────────────────────────────────────────────

test("#29 (8): a malformed file resolves every key to DEFAULT and reports the error", () => {
  const home = freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  const file = store.securitySettingsFilePath();
  assert.equal(file, path.join(home, "gryphon", "security-settings.json"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const reported: string[] = [];
  const off = store.onSecurityStoreError((m: string) => reported.push(m));
  try {
    const { result: eff, errors } = captureErrors(() => store.effectiveSecuritySettings({ permissionMode: "bypassPermissions" }, scope));
    assert.equal(eff.permissionMode, "default");
    assert.ok(errors.some((e) => e.includes("security-settings.json")), errors.join("\n"));
    assert.ok(reported.some((m) => m.includes("security-settings.json")), "the error sink (Notice) names the file");
  } finally { off(); }
});

test("#29 (8): an invalid per-key value is dropped and resolves to DEFAULT", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  const file = store.securitySettingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: {
    values: { permissionMode: "superYolo", protectedMode: "no", blockPackageInstall: false, protectedPathsDisabled: [".obsidian/plugins/gryphon/", "not-a-default/"] },
  } } } } }));
  const { result: eff, errors } = captureErrors(() => store.effectiveSecuritySettings({}, scope));
  assert.equal(eff.permissionMode, "default");
  assert.equal(eff.protectedMode, true);
  assert.equal(eff.blockPackageInstall, false, "a valid value in the same entry still applies");
  assert.deepEqual([...eff.protectedPathsDisabled], [".obsidian/plugins/gryphon/"], "only built-in patterns can be disabled");
  assert.ok(errors.some((e) => /permissionMode/.test(e)));
  assert.throws(() => store.setMachineSecuritySetting(scope, "permissionMode", "superYolo"), /unknown permissionMode/);
  assert.throws(() => store.setMachineSecuritySetting(scope, "protectedMode", "no"), /true or false/);
});

test("#29 (8): writes for two vaults and two hosts all survive; file mode is 0600", { skip: process.platform === "win32" }, () => {
  freshConfigHome();
  const s1 = { vaultKey: vaultDir(), hostId: "gryphon" };
  const s2 = { vaultKey: vaultDir(), hostId: "gryphon" };
  const s3 = { vaultKey: s1.vaultKey, hostId: "host-b" };
  store.setMachineSecuritySetting(s1, "permissionMode", "bypassPermissions");
  store.setMachineSecuritySetting(s2, "protectedMode", false);
  store.setMachineSecuritySetting(s3, "permissionMode", "acceptEdits");
  store.setMachineSecuritySetting(s1, "blockPackageInstall", false);
  assert.deepEqual(store.readMachineSecuritySettings(s1), { permissionMode: "bypassPermissions", blockPackageInstall: false });
  assert.deepEqual(store.readMachineSecuritySettings(s2), { protectedMode: false });
  assert.deepEqual(store.readMachineSecuritySettings(s3), { permissionMode: "acceptEdits" });
  const mode = fs.statSync(store.securitySettingsFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("#29 (8): an external write to the file is picked up (cache keyed on the file's stat)", () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  store.setMachineSecuritySetting(scope, "permissionMode", "acceptEdits");
  assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "acceptEdits");
  const file = store.securitySettingsFilePath();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "plan";
  fs.writeFileSync(file, JSON.stringify(data) + "\n\n");
  assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
});

// ── store-deny pin (item 12) ────────────────────────────────────────────

test("#29 (12): `cat ~/.config/gryphon/security-settings.json` is protected with Protected Mode off", () => {
  const off = { protectedMode: false, protectedCommandsEnabled: false, protectedPathsEnabled: false };
  const v = classify("Bash", { command: "cat ~/.config/gryphon/security-settings.json" }, { settings: off, vaultRoot: vaultDir() });
  assert.ok(v, "the store read must be classified");
  const home = freshConfigHome();
  const w = classify("Write", { file_path: path.join(home, "gryphon", "security-settings.json"), content: "{}" }, { settings: off, vaultRoot: vaultDir() });
  assert.ok(w, "a write to the store file must be classified");
  // The claude-code deny globs used when Protected Mode is off cover it too.
  const globs = buildApprovalsStoreDenyGlobs();
  assert.ok(globs.some((g: string) => /^Bash\(\*\.config\/gryphon\*\)$/.test(g)), globs.join("\n"));
});

test("#29 (12): the store's file name alone is protected, like mcp-approvals.json (staged cd, python -c)", () => {
  const off = { protectedMode: false, protectedCommandsEnabled: false, protectedPathsEnabled: false };
  for (const [tool, command] of [
    ["Bash", `cd ~/.config && cd gryphon && echo '{}' > security-settings.json`],
    ["Bash", `python3 -c "open('Security-Settings.json','w')"`],
    ["PowerShell", `Set-Content .\\security-settings.json '{}'`],
  ]) {
    assert.ok(classify(tool, { command }, { settings: off, vaultRoot: vaultDir() }), `${command} should be protected`);
  }
  const globs = buildApprovalsStoreDenyGlobs();
  for (const g of ["Bash(*security-settings.json*)", "Bash(*Security-Settings.Json*)", "Bash(*SECURITY-SETTINGS.JSON*)"]) {
    assert.ok(globs.includes(g), `missing ${g}`);
  }
});

test("#29 (12): Windows %APPDATA% store path is the same directory", () => {
  const p = store.securitySettingsFilePath({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, homedir: "C:\\Users\\u" });
  assert.equal(p, "C:\\Users\\u\\AppData\\Roaming\\gryphon\\security-settings.json");
});

// ── enforcement reads the snapshot, not data.json ───────────────────────

test("#29: classify, the permission gate and the deny globs read ctx.security over the vault's settings", async () => {
  freshConfigHome();
  const scope = { vaultKey: vaultDir(), hostId: "gryphon" };
  const vaultSettings = { protectedMode: false, protectedCommandsEnabled: false, protectedPathsEnabled: false, permissionMode: "bypassPermissions" };
  const security = store.effectiveSecuritySettings(vaultSettings, scope);
  const plugin = { settings: vaultSettings };
  // Commands: the vault turned them off; the snapshot keeps them on.
  assert.equal(classify("Bash", { command: "rm -rf /tmp/x" }, { settings: vaultSettings }), null, "baseline: an explicit config can disable it");
  // #30 (G4): the vault's settings reached through `plugin` alone are not an input at all.
  assert.ok(classify("Bash", { command: "rm -rf /tmp/x" }, { plugin }), "plugin.settings is never an input");
  assert.ok(classify("Bash", { command: "rm -rf /tmp/x" }, { plugin, security }), "the snapshot keeps protection on");
  // The gate: Protected Mode on (snapshot) → a protected op is not demoted/auto-allowed.
  const res = await checkPermission({
    ctx: { permissionMode: "bypassPermissions", plugin: { settings: vaultSettings }, security: { ...security, autoDenyProtected: true } },
    action: "run", target: "rm -rf /tmp/x", kind: "protected-exec",
  });
  assert.equal(res.allow, false);
  // Deny globs: built from the snapshot.
  assert.ok(buildDisallowedTools(security).length > buildApprovalsStoreDenyGlobs().length);
});

test("#29: createProtectionContext honours a security snapshot over its settings", async () => {
  const ctx = protect.createProtectionContext({
    settings: { protectedMode: false, protectedCommandsEnabled: false, permissionMode: "bypassPermissions" },
    security: store.effectiveSecuritySettings({}, null),
  });
  const r = await ctx.decide({ tool: "Bash", args: { command: "rm -rf /tmp/x" } });
  assert.equal(r.decision, "deny");
});

// ── #29 security review: the store guard is a fixed invariant ────────────
// classify() flagged store writes, but permission-gate demoted every
// protected verdict to an ordinary op when Protected Mode was off — so in
// YOLO/acceptEdits a tool call could write the store, and the next spawn
// would pick up a weakening value with no user gesture.

const { gate: _gate } = require("../src/attack-detector");

for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"]) {
  test(`#29 review: Protected Mode OFF + ${mode}: a store write is refused through the gate`, async () => {
    const off = { protectedMode: false, protectedCommandsEnabled: false, protectedPathsEnabled: false, autoDenyProtected: false };
    const home = freshConfigHome();
    const target = path.join(home, "gryphon", "security-settings.json");
    const ctx = { permissionMode: mode, security: off, settings: off, plugin: null, vaultRoot: vaultDir() };
    const writeCls = classify("Write", { file_path: target, content: '{"permissionMode":"bypassPermissions"}' }, ctx);
    const r1 = await _gate(writeCls, { ctx, action: "Write", target, kind: "fileEdit" });
    assert.equal(r1.allow, false, `Write must be refused in ${mode} with Protected Mode off`);
    assert.match(String(r1.reason), /security settings or MCP approvals/);
    const cmd = `printf '{}' > ~/.config/gryphon/security-settings.json`;
    const bashCls = classify("Bash", { command: cmd }, ctx);
    const r2 = await _gate(bashCls, { ctx, action: "Bash", target: cmd, kind: "exec" });
    assert.equal(r2.allow, false, `Bash must be refused in ${mode} with Protected Mode off`);
  });
}

test("#29 review: a vault-renamed manifest id can't redirect Gryphon's own security scope", () => {
  const { describeSecurityScope } = require("../src/security-settings-store");
  const app = { vault: { adapter: { getBasePath: () => vaultDir() } } };
  const gryphonHost = { securityHostId: "gryphon", manifest: { id: "athena" } }; // vault edited manifest.json
  assert.equal(describeSecurityScope({ app, hostPlugin: gryphonHost }).scope.hostId, "gryphon");
  // #30 (G3): an embedder with no code-pinned id gets NO scope — the manifest is vault-resident.
  const embedder = { manifest: { id: "host-b" } };
  assert.equal(describeSecurityScope({ app, hostPlugin: embedder }).scope, null);
  assert.equal(describeSecurityScope({ app, hostPlugin: embedder }).missing, "hostId");
  assert.equal(describeSecurityScope({ app, hostPlugin: gryphonHost, hostId: "custom" }).scope.hostId, "custom");
});
