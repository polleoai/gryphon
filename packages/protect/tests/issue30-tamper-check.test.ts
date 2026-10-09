/**
 * Issue #30 acceptance (unit), G2 defence in depth: the turn-window tamper
 * check. It needs no hooks: hash security-settings.json at turn start,
 * re-read at turn end, and revert any entry that got WEAKER unless the new
 * content was written by Gryphon's own store writer (the renderer-global
 * ledger, shared by every bundled copy of @gryphon/protect in the window).
 *
 * Item: A5 (+ the A10 "embedded settings toggle mid-turn isn't reverted" half).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/security-settings-store");

function fresh() {
  const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-tc-cfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-tc-vault-")));
  return { file: store.securitySettingsFilePath(), scope: { vaultKey: vault, hostId: "gryphon" }, vault };
}
/** An out-of-band writer: what an agent's shell would do. */
function agentWrite(file: string, mutate: (j: any) => void) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(j);
  fs.writeFileSync(file, JSON.stringify(j));
}
function read(file: string) { return JSON.parse(fs.readFileSync(file, "utf8")); }

test("#30 A5: a weakening out-of-band write mid-turn is reverted and reported", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => {
    j.vaults[scope.vaultKey].hosts.gryphon.values.protectedMode = false;
    j.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "bypassPermissions";
  });
  const r = store.checkSecurityStoreTamper(before);
  assert.equal(r.changed, true);
  assert.deepEqual(r.reverted.map((x: any) => x.key).sort(), ["permissionMode", "protectedMode"]);
  const vals = read(file).vaults[scope.vaultKey].hosts.gryphon.values;
  assert.equal(vals.permissionMode, "default");
  assert.equal("protectedMode" in vals, false, "a key absent before the turn is removed again");
});

test("#30 A5: an added CLI path or dismissal counts as weakening; a new host entry too", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => {
    const h = j.vaults[scope.vaultKey].hosts.gryphon;
    h.paths = { claudePath: "/tmp/evil" };
    h.dismissed = { claudePath: "a".repeat(64) };
    j.vaults[scope.vaultKey].hosts.embedder = { values: { protectedMode: false }, setAt: "", dismissed: {} };
  });
  const r = store.checkSecurityStoreTamper(before);
  const keys = r.reverted.map((x: any) => `${x.hostId}:${x.key}`).sort();
  assert.deepEqual(keys, ["embedder:protectedMode", "gryphon:dismissed.claudePath", "gryphon:paths.claudePath"]);
  const j = read(file);
  assert.equal((j.vaults[scope.vaultKey].hosts.gryphon.paths || {}).claudePath, undefined);
  assert.equal((j.vaults[scope.vaultKey].hosts.embedder?.values || {}).protectedMode, undefined);
});

test("#30 A5: a strengthening out-of-band write is left alone", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", false);
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.protectedMode = true; });
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted, []);
  assert.equal(read(file).vaults[scope.vaultKey].hosts.gryphon.values.protectedMode, true);
});

test("#30 A5: Gryphon's own toggle mid-turn is not reverted", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  store.setMachineSecuritySetting(scope, "protectedMode", false);
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted, []);
  assert.equal(read(file).vaults[scope.vaultKey].hosts.gryphon.values.protectedMode, false);
});

test("#30 A5: Gryphon's toggle survives an agent write that lands after it", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  store.setMachineSecuritySetting(scope, "protectedMode", false);           // the user, in Settings
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "bypassPermissions"; });
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["permissionMode"]);
  const vals = read(file).vaults[scope.vaultKey].hosts.gryphon.values;
  assert.equal(vals.protectedMode, false, "the user's own change stays");
  assert.equal("permissionMode" in vals, false);
});

test("#30 A10/A5: a write from ANOTHER bundled copy of @gryphon/protect (an embedder's) is recognised", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting({ ...scope, hostId: "embedder" }, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  // A second module instance — what an embedder's own bundle of protect is.
  const key = require.resolve("../src/security-settings-store");
  const saved = require.cache[key];
  delete require.cache[key];
  const copy = require("../src/security-settings-store");
  require.cache[key] = saved;
  assert.notEqual(copy, store);
  copy.setMachineSecuritySetting({ ...scope, hostId: "embedder" }, "protectedMode", false);
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted, []);
  assert.equal(read(file).vaults[scope.vaultKey].hosts.embedder.values.protectedMode, false);
});

test("#30 A5: no file before or after, or an unchanged file → nothing to do", () => {
  const { scope } = fresh();
  let before = store.snapshotSecurityStore();
  assert.equal(store.checkSecurityStoreTamper(before).changed, false);
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  before = store.snapshotSecurityStore();
  assert.equal(store.checkSecurityStoreTamper(before).changed, false);
});

test("#30 A5: an out-of-band delete of the whole file is not a weakening (fails closed to defaults)", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  fs.unlinkSync(file);
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted, []);
});

test("#30 (security review): replaying an OLDER Gryphon-written file is judged like any foreign write", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", false);        // once, earlier
  const weakOld = fs.readFileSync(file, "utf8");
  store.setMachineSecuritySetting(scope, "protectedMode", true);         // the user turned it back on
  const before = store.snapshotSecurityStore();
  fs.writeFileSync(file, weakOld);                                       // the agent restores the old content
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["protectedMode"]);
  assert.equal(read(file).vaults[scope.vaultKey].hosts.gryphon.values.protectedMode, true);
});

test("#30 (security review): a Gryphon write made on top of tampered content doesn't launder it", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", true);
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "bypassPermissions"; });
  // #32: a settings write now judges the file first, so the plant is undone
  // (and reported) right there; the turn-end check then finds nothing left.
  const early: string[] = [];
  const off = store.onSecurityStoreTamper((rv: any[]) => rv.forEach((x) => early.push(x.key)));
  store.setMachineSecuritySetting(scope, "blockPackageInstall", true);  // the user, mid-turn: re-reads the tampered file
  off();
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual([...early, ...r.reverted.map((x: any) => x.key)], ["permissionMode"], "undone and reported exactly once");
  const vals = read(file).vaults[scope.vaultKey].hosts.gryphon.values;
  assert.equal("permissionMode" in vals, false);
  assert.equal(vals.blockPackageInstall, true, "the user's own change stays");
});

test("#30 (security review): a Settings list write mid-turn doesn't carry an agent's added entry forward", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedPathsDisabled", []);
  const before = store.snapshotSecurityStore();
  const [a, b] = store.validateSecurityValue("protectedPathsDisabled",
    require("../src/constants").DEFAULT_PROTECTED_PATHS.map((d: any) => d.pattern)).value;
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.protectedPathsDisabled = [a]; });
  // The user unticks `b` in Settings, which re-saves the list it sees: [a, b].
  store.setMachineSecuritySetting(scope, "protectedPathsDisabled", [a, b]);
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["protectedPathsDisabled"]);
  assert.deepEqual(read(file).vaults[scope.vaultKey].hosts.gryphon.values.protectedPathsDisabled, [b]);
});

test("#30 (security review): two foreign writes to one key revert to the trusted value, not the first foreign one", () => {
  const { file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "acceptEdits"; });
  store.setMachineSecuritySetting(scope, "blockPackageInstall", true);          // unrelated user write carries it forward
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.permissionMode = "bypassPermissions"; });
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["permissionMode"]);
  assert.equal(read(file).vaults[scope.vaultKey].hosts.gryphon.values.permissionMode, "plan");
});

test("#30 (security review): a list item a foreign write introduced is never credited to Gryphon", () => {
  const { file, scope } = fresh();
  const [a] = store.validateSecurityValue("protectedPathsDisabled",
    require("../src/constants").DEFAULT_PROTECTED_PATHS.map((d: any) => d.pattern)).value;
  store.setMachineSecuritySetting(scope, "protectedPathsDisabled", []);
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.protectedPathsDisabled = [a]; });
  store.setMachineSecuritySetting(scope, "protectedPathsDisabled", []);        // a Gryphon write drops it…
  agentWrite(file, (j) => { j.vaults[scope.vaultKey].hosts.gryphon.values.protectedPathsDisabled = []; });
  store.setMachineSecuritySetting(scope, "protectedPathsDisabled", [a]);       // …and one re-adds it
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["protectedPathsDisabled"]);
  assert.equal((read(file).vaults[scope.vaultKey].hosts.gryphon.values.protectedPathsDisabled || []).length, 0);
});
