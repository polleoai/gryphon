/**
 * Issue #30 acceptance (unit), protect layer: CLI binary paths become
 * machine-scoped (G1), the host id has no manifest fallback (G3), and
 * `plugin.settings` is never an enforcement input (G4).
 *
 * Items: A1 (unconfirmedPaths half), A2, A6, A7, A16.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const protect = require("../src/index");
const store = require("../src/security-settings-store");
const utils = require("../../provider-runtime/dist/utils");

const POSIX = process.platform !== "win32";

function freshConfigHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-cfg-")));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}
function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function appFor(basePath: string) {
  return { vault: { adapter: { getBasePath: () => basePath, basePath } }, workspace: { trigger() {} } };
}
/** An executable that answers `--version` like the named CLI. */
function fakeCli(dir: string, name: string, version = "9.9.9", sentinel?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const sig = name === "claude" ? ` (Claude Code)` : "";
  fs.writeFileSync(p, `#!/bin/sh\n${sentinel ? `touch ${JSON.stringify(sentinel)}\n` : ""}echo "${version}${sig}"\n`, { mode: 0o755 });
  return p;
}

const FINDERS = ["findClaudeBinary", "findCodexBinary", "findGeminiBinary", "findAntigravityBinary"];
const orig: Record<string, any> = {};
for (const f of FINDERS) orig[f] = utils[f];
function stubDetect(map: Record<string, string | null>) {
  for (const f of FINDERS) utils[f] = () => (f in map ? map[f] : null);
}
function restoreDetect() { for (const f of FINDERS) utils[f] = orig[f]; }

const KINDS: Array<[string, string, string, string]> = [
  // kind, key, finder, binary name
  ["claude-code", "claudePath", "findClaudeBinary", "claude"],
  ["codex-cli", "codexPath", "findCodexBinary", "codex"],
  ["gemini-cli", "geminiCliPath", "findGeminiBinary", "gemini"],
  ["antigravity-cli", "antigravityPath", "findAntigravityBinary", "agy"],
];

// ── exports ────────────────────────────────────────────────────────────

test("#30: @gryphon/protect exports the CLI-path API", () => {
  for (const k of ["resolveCliPath", "setMachineCliPath", "CliPathRejectedError", "EXECUTABLE_KEYS"]) {
    assert.ok(protect[k], `missing export ${k}`);
  }
  assert.deepEqual([...protect.EXECUTABLE_KEYS], ["claudePath", "codexPath", "geminiCliPath", "antigravityPath"]);
});

// ── A2: validation on write ────────────────────────────────────────────

test("#30 A2: setMachineCliPath refuses in-vault, relative, directory and non-executable paths", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const scope = { vaultKey: vault, hostId: "gryphon" };
  const outside = tmpDir("g30-bin-");
  const inVault = fakeCli(path.join(vault, ".tools"), "claude");
  const noExec = path.join(outside, "claude-noexec");
  fs.writeFileSync(noExec, "#!/bin/sh\necho 1.0.0\n", { mode: 0o644 });

  const reasonOf = (p: string) => {
    try { store.setMachineCliPath(scope, "claudePath", p); } catch (e: any) {
      assert.ok(e instanceof protect.CliPathRejectedError, `expected CliPathRejectedError, got ${e && e.name}`);
      assert.equal(e.key, "claudePath");
      assert.equal(e.value, p);
      return e.reason;
    }
    return "accepted";
  };
  assert.equal(reasonOf(inVault), "inside-vault");
  assert.equal(reasonOf("bin/claude"), "relative");
  assert.equal(reasonOf(outside), "not-a-file");
  assert.equal(reasonOf(noExec), "not-executable");
  assert.equal(reasonOf(path.join(outside, "nope")), "missing");

  // An in-vault symlink to an out-of-vault binary is refused too (A16).
  const real = fakeCli(outside, "claude");
  const link = path.join(vault, "claude-link");
  fs.symlinkSync(real, link);
  assert.equal(reasonOf(link), "inside-vault");

  // A valid path is stored as configured.
  assert.equal(reasonOf(real), "accepted");
  const file = store.securitySettingsFilePath();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vaults[vault].hosts.gryphon.paths.claudePath, real);
  // Clearing removes it.
  store.setMachineCliPath(scope, "claudePath", null);
  const raw2 = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal((raw2.vaults[vault].hosts.gryphon.paths || {}).claudePath, undefined);
});

test("#30: an unknown path key is refused", () => {
  freshConfigHome();
  const scope = { vaultKey: tmpDir("g30-vault-"), hostId: "gryphon" };
  assert.throws(() => store.setMachineCliPath(scope, "nodePath", "/usr/bin/node"), /unknown/);
});

// ── resolveCliPath: order, realpath, fallback ──────────────────────────

test("#30: resolveCliPath order is override → machine → detected, for all four kinds", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const app = appFor(vault);
  const bins = tmpDir("g30-bin-");
  try {
    for (const [kind, key, finder, name] of KINDS) {
      const detected = fakeCli(path.join(bins, "det"), name);
      const machine = fakeCli(path.join(bins, "mac"), name);
      const override = fakeCli(path.join(bins, "ovr"), name);
      stubDetect({ [finder]: detected });

      let r = protect.resolveCliPath(kind, { app, hostId: "gryphon" });
      assert.equal(r.path, detected, `${kind}: detected`);
      assert.equal(r.source, "detected");

      store.setMachineCliPath({ vaultKey: vault, hostId: "gryphon" }, key, machine);
      r = protect.resolveCliPath(kind, { app, hostId: "gryphon" });
      assert.equal(r.path, machine, `${kind}: machine`);
      assert.equal(r.source, "machine");
      assert.equal(r.rejected, undefined);

      r = protect.resolveCliPath(kind, { app, hostId: "gryphon", overrides: { paths: { [key]: override } } });
      assert.equal(r.path, override, `${kind}: override`);
      assert.equal(r.source, "override");

      // Another host's confirmation doesn't apply.
      r = protect.resolveCliPath(kind, { app, hostId: "embedder" });
      assert.equal(r.source, "detected", `${kind}: other host falls to detection`);
    }
  } finally { restoreDetect(); }
});

test("#30: resolveCliPath never throws and never returns a data.json path", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const sentinel = path.join(tmpDir("g30-s-"), "RAN");
  const evil = fakeCli(path.join(vault, ".tools"), "claude", "9.9.9", sentinel);
  const detected = fakeCli(tmpDir("g30-bin-"), "claude");
  stubDetect({ findClaudeBinary: detected });
  try {
    const hostPlugin = { app: appFor(vault), securityHostId: "gryphon", settings: { claudePath: evil } };
    const r = protect.resolveCliPath("claude-code", { app: hostPlugin.app, hostPlugin });
    assert.equal(r.path, detected);
    assert.equal(r.source, "detected");
    assert.equal(fs.existsSync(sentinel), false, "the vault's binary must never run");
  } finally { restoreDetect(); }
});

test("#30 A2: a stored path that later moves into the vault or disappears is rejected, with detection as fallback", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const app = appFor(vault);
  const bins = tmpDir("g30-bin-");
  const detected = fakeCli(path.join(bins, "det"), "codex");
  const stored = fakeCli(path.join(bins, "mac"), "codex");
  stubDetect({ findCodexBinary: detected });
  const warns: string[] = [];
  const ow = console.warn;
  console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
  try {
    store.setMachineCliPath({ vaultKey: vault, hostId: "gryphon" }, "codexPath", stored);
    fs.unlinkSync(stored);
    let r = protect.resolveCliPath("codex-cli", { app, hostId: "gryphon" });
    assert.equal(r.path, detected);
    assert.equal(r.source, "detected");
    assert.deepEqual(r.rejected, { key: "codexPath", value: stored, reason: "missing" });
    r = protect.resolveCliPath("codex-cli", { app, hostId: "gryphon" });
    assert.equal(r.rejected.reason, "missing");
    assert.equal(warns.filter((w) => w.includes(stored)).length, 1, "reported once");

    // The stored path is now a symlink into the vault (sync re-pointed it).
    const inVault = fakeCli(path.join(vault, "x"), "codex");
    fs.symlinkSync(inVault, stored);
    r = protect.resolveCliPath("codex-cli", { app, hostId: "gryphon" });
    assert.equal(r.path, detected);
    assert.equal(r.rejected.reason, "inside-vault");
  } finally { console.warn = ow; restoreDetect(); }
});

test("#30: resolveCliPath returns not-found when nothing is usable", () => {
  freshConfigHome();
  stubDetect({});
  try {
    const r = protect.resolveCliPath("gemini-cli", { app: appFor(tmpDir("g30-vault-")), hostId: "gryphon" });
    assert.equal(r.path, null);
    assert.equal(r.source, null);
    assert.equal(r.unavailable, "not-found");
  } finally { restoreDetect(); }
});

test("#30 A16: a confirmed symlink re-pointed by an update resolves to the new target, no rejection", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const app = appFor(vault);
  const home = tmpDir("g30-home-");
  const a = fakeCli(path.join(home, "versions", "A"), "claude", "2.0.0");
  const b = fakeCli(path.join(home, "versions", "B"), "claude", "2.1.0");
  const link = path.join(home, "bin", "claude");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(a, link);
  stubDetect({});
  try {
    store.setMachineCliPath({ vaultKey: vault, hostId: "gryphon" }, "claudePath", link);
    let r = protect.resolveCliPath("claude-code", { app, hostId: "gryphon" });
    assert.equal(r.path, a, "spawns the realpath");
    assert.equal(r.source, "machine");
    fs.unlinkSync(link);
    fs.symlinkSync(b, link);
    fs.rmSync(path.dirname(a), { recursive: true });
    r = protect.resolveCliPath("claude-code", { app, hostId: "gryphon" });
    assert.equal(r.path, b);
    assert.equal(r.source, "machine");
    assert.equal(r.rejected, undefined);
    // The store keeps the configured (symlink) path.
    const raw = JSON.parse(fs.readFileSync(store.securitySettingsFilePath(), "utf8"));
    assert.equal(raw.vaults[vault].hosts.gryphon.paths.claudePath, link);
  } finally { restoreDetect(); }
});

test("#30: no hostId → machine store skipped, override or detection only", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const detected = fakeCli(tmpDir("g30-bin-"), "agy");
  const stored = fakeCli(tmpDir("g30-bin-"), "agy");
  store.setMachineCliPath({ vaultKey: vault, hostId: "gryphon" }, "antigravityPath", stored);
  stubDetect({ findAntigravityBinary: detected });
  try {
    // manifest.id "gryphon" must NOT stand in for the host id (G3).
    const hostPlugin = { app: appFor(vault), manifest: { id: "gryphon" }, settings: {} };
    const r = protect.resolveCliPath("antigravity-cli", { app: hostPlugin.app, hostPlugin });
    assert.equal(r.path, detected);
    assert.equal(r.source, "detected");
  } finally { restoreDetect(); }
});

// ── unconfirmedPaths (A1, migration) ───────────────────────────────────

test("#30 A1: a data.json path that differs from the effective one is listed in unconfirmedPaths", { skip: !POSIX }, () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const scope = { vaultKey: vault, hostId: "gryphon" };
  const detected = fakeCli(tmpDir("g30-bin-"), "claude");
  stubDetect({ findClaudeBinary: detected });
  try {
    const evil = fakeCli(path.join(vault, ".tools"), "claude");
    let eff = store.effectiveSecuritySettings({ claudePath: evil }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], ["claudePath"]);
    // data.json equal to the detected path → nothing to confirm (most users).
    eff = store.effectiveSecuritySettings({ claudePath: detected }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], []);
    // Empty / missing → nothing.
    eff = store.effectiveSecuritySettings({ claudePath: "" }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], []);
    // Dismissed → quiet until the value changes.
    store.dismissVaultSecuritySuggestion(scope, "claudePath", evil);
    eff = store.effectiveSecuritySettings({ claudePath: evil }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], []);
    eff = store.effectiveSecuritySettings({ claudePath: evil + "2" }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], ["claudePath"]);
    // Confirmed → quiet.
    const mine = fakeCli(tmpDir("g30-bin-"), "claude");
    store.setMachineCliPath(scope, "claudePath", mine);
    eff = store.effectiveSecuritySettings({ claudePath: mine }, scope);
    assert.deepEqual([...eff.unconfirmedPaths], []);
  } finally { restoreDetect(); }
});

test("#30: the store schema stays version 1; old entries without paths read fine", () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  const file = store.securitySettingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [vault]: { hosts: { gryphon: { values: { protectedMode: false }, setAt: "", dismissed: {} } } } } }));
  const eff = store.effectiveSecuritySettings({}, { vaultKey: vault, hostId: "gryphon" });
  assert.equal(eff.protectedMode, false);
  store.setMachineSecuritySetting({ vaultKey: vault, hostId: "gryphon" }, "permissionMode", "acceptEdits");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
});

// ── G3 (A6) ────────────────────────────────────────────────────────────

test("#30 A6 (G3): an embedder with no securityHostId and manifest.id 'gryphon' doesn't see Gryphon's values", () => {
  freshConfigHome();
  const vault = tmpDir("g30-vault-");
  store.setMachineSecuritySetting({ vaultKey: vault, hostId: "gryphon" }, "protectedMode", false);
  const embedder = { app: appFor(vault), manifest: { id: "gryphon" }, settings: { protectedMode: false } };
  const d = store.describeSecurityScope({ hostPlugin: embedder });
  assert.equal(d.scope, null);
  assert.equal(d.missing, "hostId");
  const eff = store.effectiveSecuritySettings(embedder.settings, d.scope);
  assert.equal(eff.protectedMode, true);
  // A code-set securityHostId still works, and so does an explicit option.
  assert.equal(store.describeSecurityScope({ hostPlugin: { ...embedder, securityHostId: "gryphon" } }).scope.hostId, "gryphon");
  assert.equal(store.describeSecurityScope({ hostPlugin: embedder, hostId: "embedder" }).scope.hostId, "embedder");
});

// ── G4 (A7) ────────────────────────────────────────────────────────────

test("#30 A7 (G4): securityInputsOf({plugin}) returns defaults plus additive keys only", () => {
  const warns: string[] = [];
  const ow = console.warn;
  console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
  try {
    const sec = store.securityInputsOf({ plugin: { settings: {
      protectedMode: false, permissionMode: "bypassPermissions", protectedPathsEnabled: false,
      autoDenyProtected: true, protectedPathsCustom: ["secret/"], protectedCommandsCustom: ["curl"],
    } } });
    assert.equal(sec.protectedMode, true);
    assert.equal(sec.permissionMode, "default");
    assert.equal(sec.protectedPathsEnabled, true);
    assert.equal(sec.autoDenyProtected, true);
    assert.deepEqual([...sec.protectedPathsCustom], ["secret/"]);
    assert.deepEqual([...sec.protectedCommandsCustom], ["curl"]);
    assert.ok(Object.isFrozen(sec));
    store.securityInputsOf({ plugin: { settings: { protectedMode: false } } });
    assert.ok(warns.length <= 1, "warns at most once per process");
  } finally { console.warn = ow; }
  // A snapshot and an explicit settings object are still honoured.
  assert.equal(store.securityInputsOf({ security: { protectedMode: false } }).protectedMode, false);
  assert.equal(store.securityInputsOf({ settings: { protectedMode: false } }).protectedMode, false);
});

test("#30 A7 (G4): createProtectionContext({plugin}) follows defaults; explicit settings unchanged", () => {
  const ipcServer = { isListening: () => true };
  const weak = { protectedMode: false, permissionMode: "bypassPermissions" };
  const fromPlugin = protect.createProtectionContext({ plugin: { settings: weak, ipcServer } });
  assert.equal(fromPlugin.isAvailable(), true, "data.json protectedMode:false must not switch protection off");
  const explicit = protect.createProtectionContext({ plugin: { ipcServer }, settings: weak });
  assert.equal(explicit.isAvailable(), false, "an explicit, code-supplied config is still honoured");
});
