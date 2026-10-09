// Issue #32 / QA (2.11.2): notices for changes found outside a reply name
// the vault each item belongs to, and long lists are capped.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubPath = require.resolve("./_stubs/obsidian");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { Notice } = require("obsidian");
const ui = require("../src/security-settings");
const text = (n: any) => String(n.message || n.msg || n.text || "");

test("QA F2: the record-started notice names the vault of each loosened setting", () => {
  const xdg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32n-")));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const store = require("../../protect/dist/security-settings-store");
    ui.installSecurityStoreErrorNotice();
    const file = store.securitySettingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = (values: any, paths: any = {}) => ({ hosts: { gryphon: { values, setAt: "", dismissed: {}, paths } } });
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: {
      "/Users/me/Work Vault": entry({ protectedMode: false }),
      "/Users/me/Notes": entry({}, { codexPath: "/tmp/codex" }),
    } }));
    delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
    Notice.shown.length = 0;
    store.readMachineSecuritySettings({ vaultKey: "/Users/me/Notes", hostId: "gryphon" });
    const n = Notice.shown.map(text).find((m: string) => /now keeps a record of its security settings/.test(m));
    assert.ok(n, JSON.stringify(Notice.shown.map(text)));
    assert.match(n, /Protected Mode \(vault "Work Vault"\)/);
    assert.match(n, /Codex CLI location \(vault "Notes"\)/);
    assert.match(n, /open that vault/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("QA F5: a notice listing planted approvals is capped", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32n-a-")));
  try {
    const m = require("../../protect/dist/mcp-approvals");
    ui.installSecurityStoreErrorNotice();
    const file = path.join(dir, "mcp-approvals.json");
    m.approve("/v", "notes", "a".repeat(64), { file });
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (let i = 0; i < 50; i++) j.vaults["/v"][`planted${i}`] = { sha256: "b".repeat(64), approvedAt: "" };
    fs.writeFileSync(file, JSON.stringify(j));
    Notice.shown.length = 0;
    m.reader({ file }).lookup("/v", "notes");
    const n = Notice.shown.map(text).find((x: string) => /ignored MCP server approvals/.test(x));
    assert.ok(n);
    assert.match(n, /and 42 more/);
    assert.ok(n.length < 600, `notice length ${n.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review E + same-name vaults: one long name is shortened; same-named vaults are told apart", () => {
  const xdg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32n-e-")));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const store = require("../../protect/dist/security-settings-store");
    ui.installSecurityStoreErrorNotice();
    const file = store.securitySettingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = (values: any) => ({ hosts: { gryphon: { values, setAt: "", dismissed: {}, paths: {} } } });
    fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: {
      "/Users/me/Work Vault": entry({ protectedMode: false }),
      "/Volumes/USB/Work Vault": entry({ protectedMode: false }),
      ["/x/" + "L".repeat(3000)]: entry({ protectedMode: false }),
    } }));
    delete (process as any)[Symbol.for("gryphon.securityStoreTrusted")];
    Notice.shown.length = 0;
    store.readMachineSecuritySettings({ vaultKey: "/Users/me/Work Vault", hostId: "gryphon" });
    const n = Notice.shown.map(text).find((m: string) => /now keeps a record/.test(m));
    assert.ok(n);
    assert.match(n, /vault "me\/Work Vault"/);
    assert.match(n, /vault "USB\/Work Vault"/);
    assert.ok(n.length < 800, `notice length ${n.length}`);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});
