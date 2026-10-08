/**
 * Issue #30 acceptance A9 (plugin side): an embedder-shaped embedder — no IPC
 * server, Protected Mode forced off by code, `securityHostId: "embedder"` —
 *   - the chat view resolves `cliPaths` itself from ITS host id;
 *   - the one-time confirm for a data.json CLI path renders for that host and
 *     Confirm writes under `hosts.embedder.paths`, never `hosts.gryphon`;
 *   - the embedded settings renderer's CLI-path row writes under "embedder".
 * A vault-resident path can't be confirmed at all.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};
const { _el, _allSettings, Modal, Notice } = require("./_stubs/obsidian.ts");
const { GryphonChatView } = require("../src/chat-view");
const securityUi = require("../src/security-settings");
const { renderSetupPanel } = require("../src/settings-view");
const { securitySettings: store } = require("@gryphon/protect");
// The same module instance protect's resolveCliPath detects through.
const utils = require(path.join(__dirname, "..", "..", "provider-runtime", "dist", "utils"));

const POSIX = process.platform !== "win32";
const FINDERS = ["findClaudeBinary", "findCodexBinary", "findGeminiBinary", "findAntigravityBinary"];
const orig: Record<string, any> = {};
for (const f of FINDERS) orig[f] = utils[f];

function fresh() {
  process.env.XDG_CONFIG_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-cfg-")));
  securityUi._resetPromptedScopes();
  const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-vault-")));
  const detected = fakeCli(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-det-"))), "claude");
  for (const f of FINDERS) utils[f] = () => (f === "findClaudeBinary" ? detected : null);
  const app = { vault: { adapter: { getBasePath: () => vault, basePath: vault } }, workspace: { on() { return {}; }, trigger() {} } };
  return { vault, detected, app };
}
function restore() { for (const f of FINDERS) utils[f] = orig[f]; }
function fakeCli(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "9.9.9 (Claude Code)"\n`, { mode: 0o755 });
  return p;
}
function rawStore() {
  const f = store.securitySettingsFilePath();
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { vaults: {} };
}
function embedderHost(app: any, settings: any = {}) {
  return { app, manifest: { id: "embedder", name: "Embedder" }, settings: { providerPreference: "claude-code", ...settings }, saveSettings: async () => {} };
}

test("#30 A9: the one-time confirm lists a data.json CLI path and Confirm writes under hosts.embedder", { skip: !POSIX }, async () => {
  const { vault, app } = fresh();
  try {
    const mine = fakeCli(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-mine-"))), "claude");
    const host = embedderHost(app, { claudePath: mine });
    const before = Modal.opened.length;
    const modal = securityUi.maybePromptVaultSecurity(app, host, { hostId: "embedder", overrides: { protectedMode: false } });
    assert.ok(modal, "the prompt opened");
    assert.equal(Modal.opened.length, before + 1);
    assert.ok(modal.pathKeys.includes("claudePath"));
    const text = JSON.stringify(modal.contentEl);
    assert.ok(text.includes(mine), "names the full resolved path");
    await modal.confirm();
    const s = rawStore();
    assert.equal(s.vaults[vault].hosts.embedder.paths.claudePath, mine);
    assert.equal(s.vaults[vault].hosts.gryphon, undefined);
  } finally { restore(); }
});

test("#30 A9: a vault-resident CLI path is flagged and can't be confirmed", { skip: !POSIX }, async () => {
  const { vault, app } = fresh();
  try {
    const evil = fakeCli(path.join(vault, ".tools"), "claude");
    const host = embedderHost(app, { claudePath: evil });
    const modal = securityUi.maybePromptVaultSecurity(app, host, { hostId: "embedder", force: true });
    assert.ok(modal);
    assert.ok(JSON.stringify(modal.contentEl).includes("inside this vault"));
    const shown = Notice.shown.length;
    await modal.confirm();
    assert.ok(Notice.shown.length > shown, "the refusal is visible");
    assert.equal(((rawStore().vaults[vault] || { hosts: {} }).hosts.embedder?.paths || {}).claudePath, undefined);
    // Dismiss quiets it.
    modal.keepProtections();
    const eff = store.effectiveSecuritySettings(host.settings, { vaultKey: vault, hostId: "embedder" });
    assert.deepEqual([...eff.unconfirmedPaths], []);
  } finally { restore(); }
});

test("#30 A9: the embedded settings CLI-path row writes under the renderer's securityHostId", { skip: !POSIX }, async () => {
  const { vault, app } = fresh();
  try {
    const host = embedderHost(app);
    const panel = _el();
    renderSetupPanel(host, panel, { rerenderSelf() {}, rerenderAll() {} }, { securityHostId: "embedder" });
    const row = _allSettings(panel).find((s: any) => s.name === "Claude Code path");
    assert.ok(row, "Claude Code path row rendered");
    const text = row.controls.find((c: any) => c.type === "text");
    const mine = fakeCli(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-row-"))), "claude");
    await text.changeHandler(mine);
    let s = rawStore();
    assert.equal(s.vaults[vault].hosts.embedder.paths.claudePath, mine);
    assert.equal(s.vaults[vault].hosts.gryphon, undefined);
    // An invalid value is refused, not stored, and doesn't throw.
    await text.changeHandler(path.join(vault, "claude"));
    s = rawStore();
    assert.equal(s.vaults[vault].hosts.embedder.paths.claudePath, mine);
    // Clearing removes it.
    await text.changeHandler("");
    s = rawStore();
    assert.equal(s.vaults[vault].hosts.embedder.paths?.claudePath, undefined);
  } finally { restore(); }
});

test("#30 A9: the chat view resolves cliPaths from its own securityHostId, never data.json", { skip: !POSIX }, () => {
  const { vault, app, detected } = fresh();
  try {
    const evil = fakeCli(path.join(vault, ".tools"), "claude");
    const view = Object.create(GryphonChatView.prototype);
    view.app = app;
    view.plugin = embedderHost(app, { claudePath: evil });
    view.securityHostId = "embedder";
    view.securityOverrides = { protectedMode: false };
    view.securityPathOverrides = {};
    let paths = view._resolveCliPaths();
    assert.equal(paths["claude-code"], detected);
    const mine = fakeCli(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30p-v-"))), "claude");
    store.setMachineCliPath({ vaultKey: vault, hostId: "embedder" }, "claudePath", mine);
    paths = view._resolveCliPaths();
    assert.equal(paths["claude-code"], mine);
    // The factory-facing options carry the view's host id and resolved map.
    const o = view._cliPathOptions();
    assert.equal(o.securityHostId, "embedder");
    assert.equal(o.cliPaths["claude-code"], mine);
  } finally { restore(); }
});
