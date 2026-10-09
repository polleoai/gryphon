/**
 * Issue #32: the turn-end tamper check compared only a reply's start and
 * end, and the next reply took whatever was on disk as its baseline. A
 * write delayed past the turn (`nohup sh -c 'sleep 120; …' &`) became
 * trusted, and a planted CLI path then ran at the next spawn — even after
 * Protected Mode was turned back on, and across a restart.
 *
 * Now every read that finds the file changed judges it against the content
 * Gryphon itself last wrote (this process's latest write, or the trusted
 * copy kept beside the store), before the value is used.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE = "../src/security-settings-store";
const LEDGER = Symbol.for("gryphon.securityStoreWrites");

function fresh() {
  const store = require(STORE);
  const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-cfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vault-")));
  return { store, cfg, file: store.securitySettingsFilePath(), scope: { vaultKey: vault, hostId: "gryphon" } };
}
/** An out-of-band writer: what a delayed background shell would do. */
function agentWrite(file: string, mutate: (j: any) => void) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(j);
  fs.writeFileSync(file, JSON.stringify(j));
}
const host = (j: any, scope: any) => j.vaults[scope.vaultKey].hosts.gryphon;
const plant = (scope: any) => (j: any) => {
  host(j, scope).values.protectedMode = false;
  host(j, scope).paths = { ...(host(j, scope).paths || {}), codexPath: "/tmp/evil-codex" };
};
/** A new Obsidian session: no in-process ledger, a fresh module. */
function restart() {
  delete (process as any)[LEDGER];
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}protect${path.sep}src${path.sep}`)) delete require.cache[k];
  return require(STORE);
}
function listen(store: any) {
  const seen: any[] = [];
  const off = store.onSecurityStoreTamper((reverted: any[], error: unknown) => seen.push({ reverted, error }));
  return { seen, off };
}

test("#32: a write landing after the reply ended is undone before the next read uses it", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  // A reply runs and ends with nothing changed…
  const before = store.snapshotSecurityStore();
  assert.equal(store.checkSecurityStoreTamper(before).changed, false);
  // …then the delayed write lands.
  agentWrite(file, plant(scope));
  const { seen, off } = listen(store);
  try {
    const eff = store.effectiveSecuritySettings({}, scope);
    assert.equal(eff.protectedMode, true, "the planted weakening is not used");
    assert.equal(eff.paths.codexPath, undefined, "the planted CLI path is not used");
    const onDisk = host(JSON.parse(fs.readFileSync(file, "utf8")), scope);
    assert.equal("protectedMode" in onDisk.values, false);
    assert.equal((onDisk.paths || {}).codexPath, undefined);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].reverted.map((r: any) => r.key).sort(), ["paths.codexPath", "protectedMode"]);
    // The next reply's baseline is the undone content.
    const next = store.snapshotSecurityStore();
    assert.equal(next.raw, fs.readFileSync(file, "utf8"));
  } finally { off(); }
});

test("#32: the planted write is still undone after a restart", () => {
  let { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  agentWrite(file, plant(scope));
  store = restart();
  const { seen, off } = listen(store);
  try {
    assert.deepEqual(store.readMachineSecuritySettings(scope), { permissionMode: "default" });
    assert.equal(seen.length, 1);
  } finally { off(); }
});

test("#32: Gryphon's own writes and a strengthening are kept; within a session a rewritten copy doesn't count", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", false);
  const { seen, off } = listen(store);
  try {
    assert.equal(store.readMachineSecuritySettings(scope).protectedMode, false, "the user's own choice stands");
    // An outside change that only STRENGTHENS is accepted as the new baseline.
    agentWrite(file, (j) => { host(j, scope).values.protectedMode = true; });
    assert.equal(store.readMachineSecuritySettings(scope).protectedMode, true);
    assert.equal(seen.length, 0, "nothing was reported");
    // Security review F1: writing the store AND its trusted copy (what
    // another process would do — or an agent) is judged against what this
    // process accepted; a weakening is undone.
    const other = JSON.parse(fs.readFileSync(file, "utf8"));
    host(other, scope).values.permissionMode = "bypassPermissions";
    const raw = JSON.stringify(other, null, 2) + "\n";
    fs.writeFileSync(path.join(path.dirname(file), ".security-settings.trusted.json"), raw);
    fs.writeFileSync(file, raw);
    assert.notEqual(store.readMachineSecuritySettings(scope).permissionMode, "bypassPermissions");
    assert.equal(seen.length, 1);
  } finally { off(); }
});

test("#32: a first run with no trusted copy adopts the file as it is", () => {
  const { store, file, scope } = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: { values: { protectedMode: false }, setAt: "", dismissed: {}, paths: {} } } } } }));
  const s2 = restart();
  assert.equal(s2.readMachineSecuritySettings(scope).protectedMode, false);
  assert.ok(fs.existsSync(path.join(path.dirname(file), ".security-settings.trusted.json")));
});

test("#32: when the undo can't be written, the content Gryphon last saved is used and reported", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  agentWrite(file, plant(scope));
  // The store writer creates its folder 0700 itself, so a read-only folder
  // isn't a failure it sees; fail the rename instead (an immutable file).
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e: any = new Error("EPERM: operation not permitted"); e.code = "EPERM"; throw e; };
  const { seen, off } = listen(store);
  try {
    const eff = store.effectiveSecuritySettings({}, scope);
    assert.equal(eff.protectedMode, true);
    assert.equal(eff.paths.codexPath, undefined);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].error, "the failure is reported");
  } finally {
    off();
    fs.renameSync = realRename;
  }
});

test("#32: the store guard covers the trusted copy", () => {
  const { cfg } = fresh();
  const { approvalsStoreVerdict, mentionsApprovalsStore } = require("../src/mcp-approvals");
  const t = path.join(cfg, "gryphon", ".security-settings.trusted.json");
  assert.ok(approvalsStoreVerdict("Write", { file_path: t }, {}));
  assert.equal(mentionsApprovalsStore("cp x /somewhere/.security-settings.trusted.json"), true);
});

// Commit security review of 53a8cb6.
test("#32 review: deleting the trusted copy mid-session doesn't launder a plant", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  // A new reply, nothing of Gryphon's own written in this process's ledger…
  delete (process as any)[LEDGER];
  agentWrite(file, plant(scope));
  fs.rmSync(path.join(path.dirname(file), ".security-settings.trusted.json"));
  const eff = store.effectiveSecuritySettings({}, scope);
  assert.equal(eff.protectedMode, true);
  assert.equal(eff.paths.codexPath, undefined);
});

test("#32 review: with no record at all, the file is taken as it is but the user is told", () => {
  let { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  agentWrite(file, plant(scope));
  fs.rmSync(path.join(path.dirname(file), ".security-settings.trusted.json"));
  delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
  store = restart();
  const { seen, off } = listen(store);
  const infos: string[] = [];
  const off2 = store.onSecurityStoreTamper((_r: any, _e: any, info?: string) => { if (info) infos.push(info); });
  try {
    store.readMachineSecuritySettings(scope);
    assert.deepEqual(infos, ["record-started"]);
    assert.equal(seen.length, 1);
  } finally { off(); off2(); }
});

test("#32 review: the content judged is the content used (no second read)", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  const strong = fs.readFileSync(file, "utf8");
  agentWrite(file, plant(scope));
  // Race: right after the store is read, the file flips back to strong
  // content, so a second read would see nothing to undo.
  const realRead = fs.readFileSync;
  let flipped = false;
  fs.readFileSync = function (p: any, ...rest: any[]) {
    const out = realRead.call(fs, p, ...rest);
    if (!flipped && p === file) { flipped = true; fs.writeFileSync(file, strong); }
    return out;
  };
  try {
    const eff = store.effectiveSecuritySettings({}, scope);
    assert.equal(eff.protectedMode, true, "the weakened bytes that were read are not used");
    assert.equal(eff.paths.codexPath, undefined);
  } finally { fs.readFileSync = realRead; }
});

// Security review of the 2.11.2 candidate.
test("#32 review F1b: a hard link from the copy to the store is not a record", () => {
  let { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  fs.rmSync(t);
  fs.linkSync(file, t);
  agentWrite(file, plant(scope)); // in place: the link sees it too
  // Must not hold within the session (memory) nor after a restart (no copy).
  assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true);
  fs.rmSync(t); fs.linkSync(file, t);
  agentWrite(file, plant(scope));
  delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
  store = restart();
  const infos: string[] = [];
  const off = store.onSecurityStoreTamper((_r: any, _e: any, info?: string) => { if (info) infos.push(info); });
  try {
    store.readMachineSecuritySettings(scope);
    assert.deepEqual(infos, ["record-started"], "an aliased copy reads as no record, and the user is told");
    assert.equal(fs.lstatSync(t).nlink, 1, "the copy is replaced by a real file");
  } finally { off(); }
});

test("#32 review F2: a settings change in Gryphon doesn't adopt a plant that landed first", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  agentWrite(file, plant(scope));
  // The user clicks something unrelated before any read.
  store.setMachineSecuritySetting({ vaultKey: scope.vaultKey, hostId: "embedder" }, "permissionMode", "plan");
  const eff = store.effectiveSecuritySettings({}, scope);
  assert.equal(eff.protectedMode, true);
  assert.equal(eff.paths.codexPath, undefined);
  const s2 = restart();
  assert.equal(s2.effectiveSecuritySettings({}, scope).paths.codexPath, undefined, "nor after a restart");
});

test("#32 review F3: an unreadable or deleted store keeps the last saved settings, and says so", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  store.readMachineSecuritySettings(scope);
  const { seen, off } = listen(store);
  try {
    fs.writeFileSync(file, "{not json");
    assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
    // …and the garbage did not become the baseline:
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: { values: { permissionMode: "default" }, setAt: "", dismissed: {}, paths: {} } } } } }));
    assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
    fs.rmSync(file);
    assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
    assert.ok(seen.some((x) => x.error), "reported");
  } finally { off(); }
});

// Code review of the 2.11.2 candidate.
test("#32 review: a stuck undo is reported once, not on every read", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  agentWrite(file, plant(scope));
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e: any = new Error("EPERM"); e.code = "EPERM"; throw e; };
  const { seen, off } = listen(store);
  try {
    for (let i = 0; i < 5; i++) assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true);
    assert.equal(seen.length, 1);
  } finally { off(); fs.renameSync = realRename; }
});

test("#32 review: a failed save doesn't leave the trusted copy ahead of the store", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  const before = fs.readFileSync(t, "utf8");
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e: any = new Error("EPERM"); e.code = "EPERM"; throw e; };
  try {
    assert.throws(() => store.setMachineSecuritySetting(scope, "permissionMode", "plan"));
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.readFileSync(t, "utf8"), before);
});

test("#32 review N2: a store made unreadable keeps the last saved settings", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  store.readMachineSecuritySettings(scope);
  agentWrite(file, (j) => { host(j, scope).values.blockPackageInstall = true; });
  fs.chmodSync(file, 0o000);
  try {
    assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
  } finally { fs.chmodSync(file, 0o600); }
});

// Security re-review of 7ed605d.
const { processes: _processes, SETTINGS_KEYS } = require("./_process-emulation");
const processes = () => _processes(SETTINGS_KEYS, STORE);

test("#32 re-review N1a: a same-size, same-mtime in-place plant is judged, and the turn-start reference is the checked content", (t: any) => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  store.readMachineSecuritySettings(scope);
  const st = fs.statSync(file);
  const st0 = fs.statSync(file, { bigint: true });
  const raw = fs.readFileSync(file, "utf8");
  const j = JSON.parse(raw);
  host(j, scope).values.permissionMode = "default";
  const compact = JSON.stringify(j);
  assert.ok(compact.length < raw.length);
  // Same inode (in place), same size (padded), same mtime: the old stamp cache hit.
  fs.writeFileSync(file, compact + " ".repeat(raw.length - compact.length));
  assert.equal(fs.statSync(file).size, st.size);
  // Node can't set an mtime to the nanosecond; python can (skip if absent).
  const ns = fs.statSync(file, { bigint: true });
  const want = st0.mtimeNs;
  try {
    require("child_process").execFileSync("python3", ["-c", "import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))", file, String(ns.atimeNs), String(want)]);
  } catch (_) { t.skip("python3 is needed to restore an mtime to the nanosecond"); return; }
  assert.equal(fs.statSync(file).mtimeMs, st.mtimeMs, "same stamp as the cached read");
  assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "plan");
  const before = store.snapshotSecurityStore();
  agentWrite(file, (j) => { host(j, scope).values.protectedMode = false; });
  store.checkSecurityStoreTamper(before);
  const after = store.readMachineSecuritySettings(scope);
  assert.equal(after.permissionMode, "plan");
  assert.equal(after.protectedMode, undefined, "the mid-reply plant is undone too");
});

test("#32 re-review N1b: a store deleted before the reply doesn't make the turn-end undo drop settings", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  store.readMachineSecuritySettings(scope);
  const good = fs.readFileSync(file, "utf8");
  fs.rmSync(file);
  const before = store.snapshotSecurityStore();
  const j = JSON.parse(good);
  delete host(j, scope).values.permissionMode;
  host(j, scope).values.protectedMode = false;
  fs.writeFileSync(file, JSON.stringify(j));
  store.checkSecurityStoreTamper(before);
  const s2 = restart();
  assert.equal(s2.readMachineSecuritySettings(scope).permissionMode, "plan");
});

test("#32 re-review N2: a change made in another vault's window is kept; a plant in this window's vault is not", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const as = processes();
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "default"); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "permissionMode", "default"); });
  // The user loosens a setting in window A.
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "acceptEdits"); });
  as("B", (s) => { assert.equal(s.readMachineSecuritySettings(other).permissionMode, "default"); });
  as("A", (s) => { assert.equal(s.readMachineSecuritySettings(scope).permissionMode, "acceptEdits", "B didn't undo A's own change"); });
  // A plant in A's vault, written to the store AND the copy, is still caught by A.
  agentWrite(file, (j) => { host(j, scope).values.protectedMode = false; });
  fs.copyFileSync(file, path.join(path.dirname(file), ".security-settings.trusted.json"));
  as("A", (s) => { assert.equal(s.readMachineSecuritySettings(scope).protectedMode, undefined); });
});

// Third review round (1201668).
test("#32 re-review: the turn-end check keeps a change made in another vault's window during the reply", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const as = processes();
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "default"); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "permissionMode", "default"); });
  let before: any;
  as("A", (s) => { s.readMachineSecuritySettings(scope); before = s.snapshotSecurityStore(); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "protectedMode", false); });
  as("A", (s) => { assert.deepEqual(s.checkSecurityStoreTamper(before).reverted, []); });
  as("B", (s) => { assert.equal(s.readMachineSecuritySettings(other).protectedMode, false); });
  // A plant in B's vault that skips the copy is still undone at A's turn end.
  as("A", (s) => { before = s.snapshotSecurityStore(); });
  agentWrite(file, (j) => { j.vaults[other.vaultKey].hosts.gryphon.paths = { codexPath: "/tmp/evil" }; });
  as("A", (s) => { assert.deepEqual(s.checkSecurityStoreTamper(before).reverted.map((r: any) => r.key), ["paths.codexPath"]); });
});

test("#32 re-review: with the store missing, a write keeps another window's change", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const as = processes();
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "default"); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "permissionMode", "acceptEdits"); });
  fs.rmSync(file);
  as("A", (s) => { s.setMachineSecuritySetting(scope, "blockPackageInstall", true); });
  as("B", (s) => { assert.equal(s.readMachineSecuritySettings(other).permissionMode, "acceptEdits"); });
});

test("#32 re-review: a newer window's top-level field is kept, with no alert", () => {
  const { file, scope } = fresh();
  const as = processes();
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "default"); s.readMachineSecuritySettings(scope); });
  // A newer Gryphon in another window adds a top-level field (store + copy).
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.futureField = { x: 1 };
  const raw = JSON.stringify(j, null, 2) + "\n";
  fs.writeFileSync(path.join(path.dirname(file), ".security-settings.trusted.json"), raw);
  fs.writeFileSync(file, raw);
  as("A", (s) => {
    const seen: any[] = [];
    const off = s.onSecurityStoreTamper((r: any[]) => seen.push(r));
    try {
      s.readMachineSecuritySettings(scope);
      assert.equal(seen.length, 0);
    } finally { off(); }
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).futureField, { x: 1 });
});

// Fourth review round (18f4b36).
test("#32 re-review N-1: a very deep value in the trusted copy doesn't stop the turn-end undo or break reads", () => {
  const { store, file, scope } = fresh();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-")));
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  const before = store.snapshotSecurityStore();
  const deep = "[".repeat(20000) + "]".repeat(20000);
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  const copy = fs.readFileSync(t, "utf8").trimEnd();
  fs.writeFileSync(t, copy.slice(0, -1) + `, "zz": ${deep}, "vaults2": 1 }`.replace('"vaults2": 1', `"x": {"${other}": ${deep}}`));
  JSON.parse(fs.readFileSync(t, "utf8"));
  agentWrite(file, (j) => { host(j, scope).values.permissionMode = "bypassPermissions"; });
  const r = store.checkSecurityStoreTamper(before);
  assert.deepEqual(r.reverted.map((x: any) => x.key), ["permissionMode"]);
  assert.equal(store.effectiveSecuritySettings({}, scope).permissionMode, "default");
  store.setMachineSecuritySetting(scope, "blockPackageInstall", true);
});

// Targeted re-review of 632bcb4 (R5-1).
test("#32 re-review R5-1: a very deep value accepted into the store never blocks a settings write", () => {
  const deepVal = "[".repeat(20000) + "]".repeat(20000);
  const plantBoth = (file: string, inject: (raw: string) => string) => {
    const raw = inject(fs.readFileSync(file, "utf8").trimEnd());
    fs.writeFileSync(file, raw);
    fs.writeFileSync(path.join(path.dirname(file), ".security-settings.trusted.json"), raw);
  };
  const topLevel = (raw: string) => raw.slice(0, -1) + `, "zz": ${deepVal} }`;
  // B: top-level, store + copy; F: under another vault, store + copy.
  for (const inject of [topLevel, (raw: string) => raw.replace('"vaults": {', `"vaults": { "/other-vault": ${deepVal},`)]) {
    const { store, file, scope } = fresh();
    store.setMachineSecuritySetting(scope, "permissionMode", "default");
    store.readMachineSecuritySettings(scope);
    plantBoth(file, inject);
    JSON.parse(fs.readFileSync(file, "utf8"));
    store.readMachineSecuritySettings(scope);
    store.setMachineSecuritySetting(scope, "permissionMode", "plan");
    assert.equal(store.readMachineSecuritySettings(scope).permissionMode, "plan");
    // …and after a restart.
    const s2 = restart();
    s2.setMachineSecuritySetting(scope, "blockPackageInstall", true);
  }
  // C: first-run adoption of a deep store; D: store missing, deep copy.
  {
    const { file, scope } = fresh();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{"version":1,"vaults":{},"zz":${deepVal}}`);
    const s2 = restart();
    s2.readMachineSecuritySettings(scope);
    s2.setMachineSecuritySetting(scope, "permissionMode", "plan");
    fs.rmSync(file);
    const s3 = restart();
    s3.setMachineSecuritySetting(scope, "blockPackageInstall", true);
    assert.equal(s3.readMachineSecuritySettings(scope).permissionMode, "plan");
  }
});

// Re-review of 149a928 (R6-1).
test("#32 re-review R6-1: a deep value in this window's record doesn't make it undo another window's change", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const deepVal = "[".repeat(20000) + "]".repeat(20000);
  const as = processes();
  as("A", (s) => { s.setMachineSecuritySetting(scope, "permissionMode", "default"); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "permissionMode", "plan"); });
  // A deep value under A's own host entry, in both files; A restarts and accepts it.
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  const raw = fs.readFileSync(file, "utf8").replace('"values": {', `"zz": ${deepVal}, "values": {`);
  JSON.parse(raw);
  fs.writeFileSync(file, raw); fs.writeFileSync(t, raw);
  as("A2", (s) => { s.readMachineSecuritySettings(scope); });
  as("B", (s) => { s.setMachineSecuritySetting(other, "permissionMode", "acceptEdits"); });
  as("A2", (s) => {
    const seen: any[] = [];
    const off = s.onSecurityStoreTamper((r: any[]) => seen.push(r));
    try { s.readMachineSecuritySettings(scope); assert.equal(seen.length, 0, "no false alert"); } finally { off(); }
  });
  as("B", (s) => { assert.equal(s.readMachineSecuritySettings(other).permissionMode, "acceptEdits"); });
});

// Re-review of 5b25664 (R7-1).
test("#32 re-review R7-1: a deep invalid value can't stop the turn-end check from undoing a plant", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  store.readMachineSecuritySettings(scope);
  const before = store.snapshotSecurityStore();
  const deep = "[".repeat(100000) + "]".repeat(100000);
  const raw = fs.readFileSync(file, "utf8").replace('"permissionMode": "default"', `"permissionMode": ${deep}, "protectedMode": false`);
  JSON.parse(raw);
  fs.writeFileSync(file, raw);
  const r = store.checkSecurityStoreTamper(before);
  assert.ok(r.reverted.some((x: any) => x.key === "protectedMode"), JSON.stringify(r.reverted));
  const vals = host(JSON.parse(fs.readFileSync(file, "utf8")), scope).values;
  assert.equal("protectedMode" in vals, false);
  assert.equal(store.readMachineSecuritySettings(scope).protectedMode, undefined);
});

// QA P2-A.
test("#32 QA P2-A: with no record, the notice names what the adopted settings loosen", () => {
  let { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "plan");
  agentWrite(file, plant(scope));
  fs.rmSync(path.join(path.dirname(file), ".security-settings.trusted.json"));
  delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
  store = restart();
  const got: any[] = [];
  const off = store.onSecurityStoreTamper((r: any[], _e: any, info?: string) => { if (info === "record-started") got.push(r.map((x) => x.key).sort()); });
  try {
    store.readMachineSecuritySettings(scope);
    assert.deepEqual(got, [["paths.codexPath", "protectedMode"]], "plan is stricter than the default, so it isn't named");
  } finally { off(); }
});

// Post-push review of 3b6d4be.
test("#32 post-push F2: a user with no settings file still has a baseline — a delayed file isn't adopted", () => {
  const { store, file, scope } = fresh();
  // Never changed a setting: no store, no copy. A reply runs and ends.
  const before = store.snapshotSecurityStore();
  assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true);
  assert.equal(store.checkSecurityStoreTamper(before).changed, false);
  // The delayed write creates the store.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bin = path.join(path.dirname(file), "evil-codex");
  const marker = bin + ".ran";
  fs.writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\necho 'codex-cli 9.9.9'\n`, { mode: 0o755 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: {
    values: { protectedMode: false, permissionMode: "bypassPermissions" }, setAt: "", dismissed: {}, paths: { codexPath: bin } } } } } }));
  const { seen, off } = listen(store);
  try {
    const eff = store.effectiveSecuritySettings({}, scope);
    assert.equal(eff.protectedMode, true);
    assert.equal(eff.permissionMode, "default");
    assert.equal(eff.paths.codexPath, undefined);
    const r = store.resolveCliPath("codex-cli", { hostId: "gryphon", app: { vault: { adapter: { basePath: scope.vaultKey } } }, detect: () => null });
    assert.notEqual(r.path, fs.realpathSync(bin));
    assert.equal(fs.existsSync(marker), false, "the planted program never ran");
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].error);
  } finally { off(); }
});

test("#32 post-push F1: this window's earlier write, replayed into the store, can't bring back another vault's old settings", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const as = processes();
  let X = "";
  as("W2", (s) => { s.setMachineSecuritySetting(other, "protectedMode", false); });
  as("W1", (s) => { s.effectiveSecuritySettings({}, scope); s.setMachineSecuritySetting(scope, "permissionMode", "default"); X = fs.readFileSync(file, "utf8"); });
  as("W2", (s) => { s.setMachineSecuritySetting(other, "protectedMode", true); });
  as("W1", (s) => {
    const before = s.snapshotSecurityStore();
    fs.writeFileSync(file, X);
    s.effectiveSecuritySettings({}, scope);
    s.checkSecurityStoreTamper(before);
  });
  as("W2-restarted", (s) => { assert.equal(s.effectiveSecuritySettings({}, other).protectedMode, true); });
});

test("#32 post-push F4: a second bundled copy in the same window doesn't serve stale cached settings", () => {
  const { store: A, file, scope } = fresh();
  A.setMachineSecuritySetting(scope, "protectedMode", false);
  assert.equal(A.readMachineSecuritySettings(scope).protectedMode, false);
  const X = fs.readFileSync(file, "utf8");
  // A second copy of the library in the same process (e.g. an embedder's).
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}protect${path.sep}src${path.sep}`)) delete require.cache[k];
  const B = require(STORE);
  B.setMachineSecuritySetting(scope, "protectedMode", true);
  fs.writeFileSync(file, X); // the agent restores the old bytes
  assert.equal(A.effectiveSecuritySettings({}, scope).protectedMode, true);
});

test("#32 re-review of dcd9fc3: an UNREADABLE store on first run isn't recorded as the defaults", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  let { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "protectedMode", false);
  // The 2.11.1 state: a store, no record.
  fs.rmSync(path.join(path.dirname(file), ".security-settings.trusted.json"));
  delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
  store = restart();
  fs.chmodSync(file, 0o000);
  try { store.readMachineSecuritySettings(scope); } finally { fs.chmodSync(file, 0o600); }
  assert.equal(store.readMachineSecuritySettings(scope).protectedMode, false, "the user's own choice survives");
  const s2 = restart();
  assert.equal(s2.readMachineSecuritySettings(scope).protectedMode, false);
});

// Re-review of 0fd38d0: the agent picks the read error, or breaks the record.
const plantStore = (file: string, scope: any) => fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: {
  values: { protectedMode: false }, setAt: "", dismissed: {}, paths: { codexPath: "/tmp/evil-codex" } } } } } }));

for (const [name, breakIt] of [
  ["a directory", (f: string) => { fs.rmSync(f, { force: true }); fs.mkdirSync(f); }],
  ["a symlink loop", (f: string) => { fs.rmSync(f, { force: true }); fs.symlinkSync(f, f); }],
] as Array<[string, (f: string) => void]>) {
  test(`#32 re-review: a store replaced by ${name} before a restart doesn't switch the baseline off`, { skip: process.platform === "win32" }, () => {
    let { store, file, scope } = fresh();
    store.readMachineSecuritySettings(scope); // fresh user: the defaults are recorded (folder created)
    assert.ok(fs.existsSync(path.join(path.dirname(file), ".security-settings.trusted.json")), "the record is on disk");
    breakIt(file);
    store = restart();
    assert.equal(store.readMachineSecuritySettings(scope).protectedMode, undefined);
    fs.rmSync(file, { recursive: true, force: true });
    plantStore(file, scope);
    const eff = store.effectiveSecuritySettings({}, scope);
    assert.equal(eff.protectedMode, true);
    assert.equal(eff.paths.codexPath, undefined);
  });
}

test("#32 re-review: a record deleted or replaced while Gryphon runs is put back before a restart", { skip: process.platform === "win32" }, () => {
  for (const how of ["delete", "symlink", "directory"]) {
    let { store, file, scope } = fresh();
    store.setMachineSecuritySetting(scope, "permissionMode", "default");
    const t = path.join(path.dirname(file), ".security-settings.trusted.json");
    const keep = t + ".keep";
    fs.copyFileSync(t, keep);
    fs.rmSync(t);
    if (how === "symlink") fs.symlinkSync(keep, t);
    if (how === "directory") fs.mkdirSync(t);
    store.readMachineSecuritySettings(scope); // any lookup (no store change)
    const st = fs.lstatSync(t);
    assert.ok(st.isFile(), `${how}: the record is a plain file again`);
    store = restart();
    plantStore(file, scope);
    assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true, how);
  }
});

test("#32 re-review: a FIFO at the store path doesn't freeze the read", { skip: process.platform === "win32" }, (t: any) => {
  const { store, file, scope } = fresh();
  store.readMachineSecuritySettings(scope);
  try { require("child_process").execFileSync("/usr/bin/mkfifo", [file]); } catch (e) { t.skip(`mkfifo unavailable: ${(e as Error).message}`); return; }
  assert.ok(fs.lstatSync(file).isFIFO(), "a FIFO is in place");
  const t0 = Date.now();
  assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true);
  assert.ok(Date.now() - t0 < 2000);
});

test("#32 review F1: a store kept as a symlink by a dotfile manager is honoured (and judged like a file)", { skip: process.platform === "win32" }, () => {
  let { store, file, scope } = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dot = path.join(path.dirname(path.dirname(file)), "dotfiles-security-settings.json");
  fs.writeFileSync(dot, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: { values: { permissionMode: "plan" }, setAt: "", dismissed: {}, paths: {} } } } } }));
  fs.symlinkSync(dot, file);
  store = restart();
  assert.equal(store.readMachineSecuritySettings(scope).permissionMode, "plan", "the linked settings apply");
  // A later plant through the link is still judged.
  fs.writeFileSync(dot, JSON.stringify({ version: 1, vaults: { [scope.vaultKey]: { hosts: { gryphon: { values: { permissionMode: "plan", protectedMode: false }, setAt: "", dismissed: {}, paths: {} } } } } }));
  assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, true);
});

test("#32 review: a non-empty folder planted at the record path is moved aside, never deleted recursively", { skip: process.platform === "win32" }, () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  fs.rmSync(t);
  fs.mkdirSync(t);
  fs.writeFileSync(path.join(t, "keep-me.txt"), "x");
  store.readMachineSecuritySettings(scope);
  assert.ok(fs.lstatSync(t).isFile(), "the record is back");
  const aside = fs.readdirSync(path.dirname(file)).find((n: string) => n.startsWith(".security-settings.trusted.json.not-a-record-"));
  assert.ok(aside && fs.existsSync(path.join(path.dirname(file), aside, "keep-me.txt")), "the folder's contents were kept");
});

// Post-release review of 2.11.2: for the SECURITY SETTINGS, two programs running
// Gryphon for the same vault is a documented limit (CHANGELOG [2.11.3]) — a
// tightening made in one can be undone in the other by a replayed older file.
// (A second check against the record was tried and removed: it kept opening
// fail-opens.) The approvals equivalent IS covered (issue32-approvals-tamper).

// Re-review of 80f136f.

test("#32 2.11.3 (b): a failed record write doesn't undo the user's own change", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "permissionMode", "default");
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  const realRename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from: string, to: string) => { if (to === t && !failed) { failed = true; throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } return realRename(from, to); };
  const { seen, off } = listen(store);
  try {
    store.setMachineSecuritySetting(scope, "protectedMode", false);
  } finally { fs.renameSync = realRename; }
  try {
    assert.equal(store.effectiveSecuritySettings({}, scope).protectedMode, false, "the user's own choice stands");
    assert.equal(seen.length, 0, "no 'outside Gryphon' notice");
  } finally { off(); }
});

test("#32 2.11.3: with no store at a reply's start, another window's change during the reply is kept", () => {
  const { file, scope } = fresh();
  const other = { vaultKey: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32-vB-"))), hostId: "gryphon" };
  const as = processes();
  let before: any;
  as("A", (s) => { s.readMachineSecuritySettings(scope); before = s.snapshotSecurityStore(); });
  assert.equal(before.raw, null);
  as("B", (s) => { s.setMachineSecuritySetting(other, "protectedMode", false); });
  as("A", (s) => { assert.deepEqual(s.checkSecurityStoreTamper(before).reverted, []); });
  as("B", (s) => { assert.equal(s.readMachineSecuritySettings(other).protectedMode, false); });
});

test("#32 2.11.3 (re-review of 86d167a): a looser record plus a locked store can't loosen a served vault", () => {
  const { store, file, scope } = fresh();
  store.setMachineSecuritySetting(scope, "blockPackageInstall", false);
  store.readMachineSecuritySettings(scope);
  // The agent writes only the record: looser on two keys, stricter on one.
  const t = path.join(path.dirname(file), ".security-settings.trusted.json");
  const rec = JSON.parse(fs.readFileSync(t, "utf8"));
  Object.assign(host(rec, scope).values, { protectedMode: false, permissionMode: "bypassPermissions", blockPackageInstall: true });
  fs.writeFileSync(t, JSON.stringify(rec, null, 2) + "\n");
  // …and the store can't be saved.
  const realRename = fs.renameSync;
  fs.renameSync = (from: string, to: string) => { if (to === file) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); return realRename(from, to); };
  try {
    // A fresh read (an empty cache), same process memory: e.g. another
    // bundled copy, or after the cache was cleared by any write.
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}protect${path.sep}src${path.sep}`)) delete require.cache[k];
    const fresh2 = require(STORE);
    for (let i = 0; i < 3; i++) {
      const eff = fresh2.effectiveSecuritySettings({}, scope);
      assert.equal(eff.protectedMode, true);
      assert.notEqual(eff.permissionMode, "bypassPermissions");
    }
  } finally { fs.renameSync = realRename; }
});
