// R43-8: a write must not erase what this version doesn't understand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/security-settings-store");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-8-"));
  return { dir, file: path.join(dir, "security-settings.json") };
}
const SCOPE = { vaultKey: "/v/one", hostId: "gryphon" };

test("R43-8: a write keeps other entries, unknown top-level and unknown in-entry fields", () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      futureTopLevel: { keep: true },
      vaults: {
        "/v/one": { hosts: { gryphon: { values: {}, setAt: "", dismissed: {}, paths: {}, futureField: 7, values_extra: 1 } } },
        "/v/two": { hosts: { otherhost: { values: { protectedMode: false }, setAt: "x", dismissed: {}, paths: { codexPath: "/opt/codex" }, futureField: "y" } } },
      },
    }));
    store.setMachineSecuritySetting(SCOPE, "protectedMode", false, { file });
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(out.futureTopLevel, { keep: true });
    assert.equal(out.vaults["/v/one"].hosts.gryphon.futureField, 7);
    assert.equal(out.vaults["/v/one"].hosts.gryphon.values.protectedMode, false);
    assert.deepEqual(out.vaults["/v/two"].hosts.otherhost.paths, { codexPath: "/opt/codex" });
    assert.equal(out.vaults["/v/two"].hosts.otherhost.futureField, "y");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-8: unknown keys inside values/paths of the edited entry survive", () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      vaults: { "/v/one": { hosts: { gryphon: { values: { someFutureKey: "z" }, setAt: "", dismissed: {}, paths: { futurePath: "/x" } } } } },
    }));
    store.setMachineSecuritySetting(SCOPE, "protectedMode", false, { file });
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.someFutureKey, "z");
    assert.equal(e.paths.futurePath, "/x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-8: a planted future `version` can't lock the user out of their settings", () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 99, vaults: {}, futureTopLevel: 1 }));
    store.setMachineSecuritySetting(SCOPE, "protectedMode", false, { file });
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(out.vaults["/v/one"].hosts.gryphon.values.protectedMode, false);
    assert.equal(out.futureTopLevel, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-8 review: unknown fields planted during a reply are restored at turn end", () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, keepMe: 1, vaults: { "/v/one": { hosts: { gryphon: { values: {}, setAt: "", dismissed: {}, paths: {}, legacy: "a" } } } } }));
    const before = store.snapshotSecurityStore({ file });
    // A foreign write mid-reply: only fields this version doesn't know.
    fs.writeFileSync(file, JSON.stringify({ version: 1, keepMe: 1, planted: true, vaults: { "/v/one": { hosts: { gryphon: { values: { futureWeakKey: true }, setAt: "", dismissed: {}, paths: {}, legacy: "b" } } } } }));
    const r = store.checkSecurityStoreTamper(before);
    assert.equal(r.reverted.length, 1);
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(out.planted, undefined);
    assert.equal(out.keepMe, 1);
    const e = out.vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.futureWeakKey, undefined);
    assert.equal(e.legacy, "a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-8 review 2: a value this version rejects, planted under a known key, is restored", () => {
  const { dir, file } = tmpFile();
  try {
    store.setMachineSecuritySetting({ vaultKey: "/v/one", hostId: "gryphon" }, "protectedMode", true, { file });
    store.setMachineSecuritySetting({ vaultKey: "/v/one", hostId: "other" }, "protectedMode", true, { file });
    const before = store.snapshotSecurityStore({ file });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = raw.vaults["/v/one"].hosts.other;
    e.values.permissionMode = "auto";               // a mode a FUTURE Gryphon may accept
    e.values.obsidianRestApiPolicy = "read-write";
    e.paths = { claudePath: "relative/claude" };
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = store.checkSecurityStoreTamper(before);
    assert.ok(r.reverted.length >= 1);
    const out = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.other;
    assert.equal(out.values.permissionMode, undefined);
    assert.equal(out.values.obsidianRestApiPolicy, undefined);
    assert.equal((out.paths || {}).claudePath, undefined);
    assert.equal(out.values.protectedMode, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Review 3: the restore must credit Gryphon's OWN writes during the turn.
function startWith(file: string, entry: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v/one": { hosts: { gryphon: { setAt: "", dismissed: {}, paths: {}, values: {}, ...entry } } } } }));
}

test("R43-8 review 3: the user's own mid-turn fix of an unclean value is not undone", () => {
  const { dir, file } = tmpFile();
  try {
    // A: a list holding a pattern this version doesn't know → user re-enables everything.
    startWith(file, { values: { protectedPathsDisabled: [".obsidian/plugins/gryphon/", "old-pattern"] } });
    let before = store.snapshotSecurityStore({ file });
    store.setMachineSecuritySetting(SCOPE, "protectedPathsDisabled", [], { file });
    store.checkSecurityStoreTamper(before);
    let e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.deepEqual(e.values.protectedPathsDisabled, [], "A: the re-enabled protection stays on");

    // B: an unrecognised mode → user picks plan.
    startWith(file, { values: { permissionMode: "auto" } });
    before = store.snapshotSecurityStore({ file });
    store.setMachineSecuritySetting(SCOPE, "permissionMode", "plan", { file });
    store.checkSecurityStoreTamper(before);
    e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.permissionMode, "plan", "B");

    // C: a values bag that isn't an object → user sets a value.
    startWith(file, { values: null });
    before = store.snapshotSecurityStore({ file });
    store.setMachineSecuritySetting(SCOPE, "protectedMode", true, { file });
    store.checkSecurityStoreTamper(before);
    e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values && e.values.protectedMode, true, "C");

    // D: a relative CLI path → user confirms a real one.
    startWith(file, { paths: { claudePath: "claude" } });
    before = store.snapshotSecurityStore({ file });
    store.setMachineCliPath(SCOPE, "claudePath", "/bin/sh", { file });
    store.checkSecurityStoreTamper(before);
    e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.paths.claudePath, "/bin/sh", "D");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-8 review 3: a foreign unclean plant after Gryphon's own write is still restored", () => {
  const { dir, file } = tmpFile();
  try {
    startWith(file, { values: { permissionMode: "auto" } });
    const before = store.snapshotSecurityStore({ file });
    store.setMachineSecuritySetting(SCOPE, "permissionMode", "plan", { file });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.vaults["/v/one"].hosts.gryphon.values.obsidianRestApiPolicy = "read-write";
    fs.writeFileSync(file, JSON.stringify(raw));
    store.checkSecurityStoreTamper(before);
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.permissionMode, "plan");
    assert.equal(e.values.obsidianRestApiPolicy, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
