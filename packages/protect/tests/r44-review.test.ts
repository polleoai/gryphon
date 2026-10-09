// Round 44 (review of the 2.11.1 candidate): regressions and gaps found in
// the R43 fixes themselves.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { approvalsStoreVerdict, isApprovalsStorePath } = require("../src/mcp-approvals");
const { classify } = require("../src/attack-detector");

const SECURITY = { protectedMode: true, protectedPathsEnabled: true, protectedCommandsEnabled: true };
const FIRMLINK = "/System/Volumes/Data";
const hasFirmlink = process.platform === "darwin" && fs.existsSync(FIRMLINK);

function withStore(fn: (xdg: string, store: string) => void) {
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r44-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fs.mkdirSync(path.join(xdg, "gryphon"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "gryphon", "security-settings.json"), "{}");
    fn(xdg, path.join(xdg, "gryphon"));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

test("R44 (SF-1/CR8): a note that DOCUMENTS patch syntax is an ordinary write", () => {
  withStore(() => {
    const content = "How Codex patches:\n*** Begin Patch\n*** Update File: ~/.config/gryphon/mcp-approvals.json\n*** End Patch\n";
    assert.equal(approvalsStoreVerdict("Write", { file_path: "/tmp/notes/codex.md", content }, {}), null);
    const many = Array.from({ length: 2500 }, (_: unknown, i: number) => `*** Delete File: f${i}.md`).join("\n");
    assert.equal(approvalsStoreVerdict("Write", { file_path: "/tmp/notes/big.md", content: many }, {}), null);
  });
});

test("R44 (SF-1): deeply nested MCP input is not refused as 'too many files'", () => {
  withStore(() => {
    let deep: any = { text: "hello" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    assert.equal(approvalsStoreVerdict("mcp__notion__create_page", { page: deep }, {}), null);
    assert.equal(approvalsStoreVerdict("TodoWrite", { todos: [deep] }, {}), null);
  });
});

test("R44 (R2-1): an alias with `..` before the store is still the store", { skip: !hasFirmlink }, () => {
  withStore((xdg, store) => {
    // String concatenation on purpose: path.join would collapse the `..`.
    const viaDotDot = FIRMLINK + xdg + "/nope/../gryphon/security-settings.json";
    if (!fs.existsSync(FIRMLINK + store)) return;
    assert.equal(isApprovalsStorePath(viaDotDot), true);
    assert.ok(approvalsStoreVerdict("Write", { file_path: viaDotDot, content: "{}" }, {}));
    const patch = { command: `*** Begin Patch\n*** Update File: ${viaDotDot}\n@@\n-a\n+b\n*** End Patch` };
    assert.ok(approvalsStoreVerdict("apply_patch", patch, {}));
  });
});

test("R44 (R2-1): classify sees a protected vault file through alias + `..`", { skip: !hasFirmlink }, () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r44v-"));
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(path.join(vault, ".git"), { recursive: true });
    const p = FIRMLINK + tmp + "/nope/../vault/.git/config";
    if (!fs.existsSync(FIRMLINK + vault)) return;
    assert.ok(classify("Write", { file_path: p }, { vaultRoot: vault, security: SECURITY }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R44 (E7-1): a padded shell patch is refused quickly, not after minutes", () => {
  withStore((xdg) => {
    const deepDir = Array.from({ length: 60 }, () => "a").join("/");
    const cds = Array.from({ length: 30 }, (_: unknown, i: number) => `cd ${deepDir}/c${i}`).join(" && ");
    const targets = Array.from({ length: 1999 }, (_: unknown, i: number) => `*** Delete File: x${i}.md`).join("\n");
    const command = `${cds} && apply_patch <<'EOF'\n*** Begin Patch\n${targets}\n*** Update File: ${path.join(xdg, "gryphon", "security-settings.json")}\n*** End Patch\nEOF`;
    const t0 = Date.now();
    const v = approvalsStoreVerdict("Bash", { command }, { cwd: xdg });
    const ms = Date.now() - t0;
    assert.ok(v, "refused");
    assert.ok(ms < 10000, `took ${ms} ms`);
  });
});

test("R44 (P8-1): a 500-file Codex patch is checked in well under a second", () => {
  withStore((xdg) => {
    const targets = Array.from({ length: 500 }, (_: unknown, i: number) => `*** Update File: notes/n${i}.md\n@@\n-a\n+b`).join("\n");
    const t0 = Date.now();
    const v = approvalsStoreVerdict("apply_patch", { command: `*** Begin Patch\n${targets}\n*** End Patch` }, { cwd: xdg });
    const ms = Date.now() - t0;
    assert.equal(v, null);
    assert.ok(ms < 1500, `took ${ms} ms`);
  });
});

const store = require("../src/security-settings-store");
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r44s-"));
  return { dir, file: path.join(dir, "security-settings.json") };
}
const SCOPE = { vaultKey: "/v/one", hostId: "gryphon" };

test("R44 (F1): a write keeps a known key whose value this version can't read", () => {
  const { dir, file } = tmpStore();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v/one": { hosts: { gryphon: { setAt: "", dismissed: {}, paths: {}, values: { protectedPathsDisabled: { v2: ["future/**"] } } } } } } }));
    store.setMachineSecuritySetting(SCOPE, "blockPackageInstall", true, { file });
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.deepEqual(e.values.protectedPathsDisabled, { v2: ["future/**"] });
    assert.equal(e.values.blockPackageInstall, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 (DP-2): a deleted entry that held unrecognised fields is rebuilt", () => {
  const { dir, file } = tmpStore();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: {
      "/v/one": { hosts: { gryphon: { setAt: "", dismissed: {}, paths: {}, values: {} } } },
      "/v/two": { hosts: { other: { setAt: "", dismissed: {}, paths: {}, values: {}, futureStrict: true } } },
    } }));
    const before = store.snapshotSecurityStore({ file });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.vaults["/v/two"];
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = store.checkSecurityStoreTamper(before);
    assert.equal(r.reverted.length, 1);
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(out.vaults["/v/two"].hosts.other.futureStrict, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 (E7-3): an entry field named \"values.X\" never turns into values.X", () => {
  const { dir, file } = tmpStore();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v/one": { hosts: { gryphon: { setAt: "", dismissed: {}, paths: {}, values: {}, "values.protectedPathsEnabled": false } } } } }));
    const before = store.snapshotSecurityStore({ file });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.planted = 1;
    fs.writeFileSync(file, JSON.stringify(raw));
    store.checkSecurityStoreTamper(before);
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.protectedPathsEnabled, undefined, "no active weakening created");
    assert.equal(e["values.protectedPathsEnabled"], false, "the odd field is kept as-is");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 (DP-1): another copy's old script survives the sweep when few scripts exist", () => {
  const { ensureStoreGuardScript } = require("../src/store-guard");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r44g-"));
  try {
    const other = path.join(dir, "store-guard-ffffffffffffffff.js");
    fs.writeFileSync(other, "// another version");
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000);
    fs.utimesSync(other, old, old);
    delete require.cache[require.resolve("../src/store-guard")];
    assert.equal(require("../src/store-guard").ensureStoreGuardScript({ dir }).ok, true);
    assert.equal(fs.existsSync(other), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 (a1a8009 review): restoring a '__proto__' vault/host key never pollutes Object.prototype", () => {
  const { dir, file } = tmpStore();
  try {
    fs.writeFileSync(file, '{"version":1,"vaults":{"__proto__":{"hosts":{"__proto__":{"values":{},"setAt":"","dismissed":{},"paths":{},"future":1}}}}}');
    const before = store.snapshotSecurityStore({ file });
    fs.writeFileSync(file, '{"version":1,"vaults":{}}');
    store.checkSecurityStoreTamper(before);
    assert.equal(({} as any).hosts, undefined, "Object.prototype.hosts must not exist");
    assert.equal(({} as any).future, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "hosts"), false);
  } finally {
    delete (Object.prototype as any).hosts;
    delete (Object.prototype as any).future;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 re-review: a field nested 5000 levels deep can't stop a weakening being undone", () => {
  const { dir, file } = tmpStore();
  try {
    store.setMachineSecuritySetting(SCOPE, "protectedMode", true, { file });
    const before = store.snapshotSecurityStore({ file });
    const raw = fs.readFileSync(file, "utf8");
    const deep = "[".repeat(5000) + "]".repeat(5000);
    const planted = raw.replace('"protectedMode": true', '"protectedMode": false').replace(/^\{/, `{"zz": ${deep},`);
    fs.writeFileSync(file, planted);
    const r = store.checkSecurityStoreTamper(before);
    assert.ok(r.reverted.length >= 1);
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(out.vaults["/v/one"].hosts.gryphon.values.protectedMode, true, "weakening undone");
    assert.equal(out.zz, undefined, "deep plant removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 re-review: an unrelated write doesn't trim a longer pattern list", () => {
  const { dir, file } = tmpStore();
  try {
    const list = [".obsidian/plugins/gryphon/", "future/**"];
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v/one": { hosts: { gryphon: { setAt: "", dismissed: {}, paths: {}, values: { protectedPathsDisabled: list } } } } } }));
    store.setMachineSecuritySetting(SCOPE, "blockPackageInstall", true, { file });
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.deepEqual(e.values.protectedPathsDisabled, list);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R44 (9cbc11e review): an oversized planted field still counts as drift and is removed", () => {
  const { dir, file } = tmpStore();
  try {
    store.setMachineSecuritySetting(SCOPE, "protectedMode", true, { file });
    const before = store.snapshotSecurityStore({ file });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.vaults["/v/one"].hosts.gryphon.values.futureAllowList = Array.from({ length: 100001 }, (_: unknown, i: number) => `p${i}`);
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = store.checkSecurityStoreTamper(before);
    assert.equal(r.reverted.length, 1);
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.futureAllowList, undefined);
    assert.equal(e.values.protectedMode, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("QA P3-1: deleting an entry that held a stricter-than-default value is undone", () => {
  const { dir, file } = tmpStore();
  try {
    store.setMachineSecuritySetting(SCOPE, "permissionMode", "plan", { file });
    const before = store.snapshotSecurityStore({ file });
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: {} }));
    const r = store.checkSecurityStoreTamper(before);
    assert.ok(r.reverted.some((x: any) => x.key === "permissionMode"), JSON.stringify(r));
    const e = JSON.parse(fs.readFileSync(file, "utf8")).vaults["/v/one"].hosts.gryphon;
    assert.equal(e.values.permissionMode, "plan");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
