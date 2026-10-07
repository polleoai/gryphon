/**
 * Issue #29 acceptance (plugin side): weakening values in a vault's data.json
 * are suggestions; they apply only once confirmed on this machine.
 *
 * Embedder case (items 1-3, 13, 14): a GryphonChatView hosted by a minimal
 * embedder-shaped host — `{ settings, saveSettings, app, manifest }`, no
 * `_vaultRoot`, no IPC — with embedder-style `securityOverrides`.
 * Gryphon case (items 5-7), per-host isolation (15), the renderer (16),
 * disabled toolbar items for overridden keys (10).
 *
 * Driven by direct method calls on views built from the prototype (the same
 * pattern as consumer-subprocess-teardown.test.ts); the store lives in a
 * per-test XDG_CONFIG_HOME.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};
const obsidian = require("./_stubs/obsidian.ts");
const { _el, _allSettings, Modal, Notice } = obsidian;
const { GryphonChatView } = require("../src/chat-view");
const securityUi = require("../src/security-settings");
const { renderDefaultsPanel, renderSectionHeading } = require("../src/settings-view");
const { PERMS } = require("../src/constants");
const { securitySettings: store } = require("@gryphon/protect");

const EMBEDDER_OVERRIDES = { protectedMode: false, protectedPathsEnabled: false, protectedCommandsEnabled: false };

function freshConfigHome() {
  process.env.XDG_CONFIG_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g29p-cfg-")));
  securityUi._resetPromptedScopes();
}
function vaultDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g29p-vault-")));
}
function makeApp(basePath) {
  const handlers = {};
  const triggered = [];
  return {
    vault: { adapter: { getBasePath: () => basePath, basePath } },
    workspace: {
      on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return { name, fn }; },
      trigger(name, ...args) { triggered.push({ name, args }); for (const fn of handlers[name] || []) fn(...args); },
    },
    _triggered: triggered,
  };
}
function makeHost({ app, id = "fixture", settings = {} } = {}) {
  const host = {
    settings: { ...settings },
    saves: 0,
    async saveSettings() { host.saves++; },
    app,
    manifest: id ? { id, name: id } : undefined,
  };
  return host;
}
function fakeEl() {
  const el = { text: "", title: "", classes: new Set() };
  el.setText = (t) => { el.text = t; return el; };
  el.setAttribute = (k, v) => { if (k === "title") el.title = v; };
  el.classList = { toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); } };
  el.addClass = (c) => el.classes.add(c);
  el.removeClass = (c) => el.classes.delete(c);
  return el;
}
/** A view as the embedder constructs it, minus the DOM. */
function makeView(host, options = {}) {
  const view = Object.create(GryphonChatView.prototype);
  view.plugin = host;
  view.app = host.app;
  view.securityOverrides = store.sanitizeSecurityOverrides(options.securityOverrides);
  view.securityHostId = options.securityHostId;
  view.viewDisplayText = options.displayText || "Fixture";
  view.permBtn = fakeEl();
  view.claudeProcess = null;
  view._flashStatus = () => {};
  view.addSystemMessage = () => {};
  view._updateRestApiChip = () => {};
  return view;
}
function liveProcess(view) {
  const proc = { alive: true, aborted: 0, isAlive() { return this.alive; }, abort() { this.alive = false; this.aborted++; } };
  view.claudeProcess = proc;
  view._providerSpawnSignature = view._computeProviderSignature();
  return proc;
}
function captureErrors(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(" ")); };
  return Promise.resolve().then(fn).then((result) => ({ result, errors }), (e) => ({ error: e, errors }))
    .finally(() => { console.error = orig; });
}

// ── Embedder case ───────────────────────────────────────────────────────

test("#29 (1): embedder first spawn is protected; badge 'Prompt ⚠'; one prompt across two views", () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, settings: { permissionMode: "bypassPermissions", ...EMBEDDER_OVERRIDES } });
  const v1 = makeView(host, { securityOverrides: EMBEDDER_OVERRIDES });
  const v2 = makeView(host, { securityOverrides: EMBEDDER_OVERRIDES });

  const sec = v1._effectiveSecurity();
  assert.deepEqual({ ...v1._securitySpawnOptions(sec), security: undefined }, { permissionMode: "default", security: undefined });
  assert.equal(v1._securitySpawnOptions(sec).security, sec, "providers enforce from the same snapshot");
  assert.equal(sec.protectedMode, false, "the consumer's capability override applies");
  assert.deepEqual([...sec.unconfirmed], ["permissionMode"], "only permissionMode prompts");

  v1._refreshPermBadge();
  assert.equal(v1.permBtn.text, "Prompt ⚠ ▾");
  assert.match(v1.permBtn.title, /not confirmed on this machine/);

  const before = Modal.opened.length;
  v1._maybePromptVaultSecurity();
  v2._maybePromptVaultSecurity();
  assert.equal(Modal.opened.length - before, 1, "exactly one prompt per scope per session");
});

test("#29 (1): the audit line is logged once per spawn when the host sets overrides", () => {
  const host = makeHost({ app: makeApp(vaultDir()) });
  const view = makeView(host, { securityOverrides: EMBEDDER_OVERRIDES });
  const lines = [];
  const orig = console.info;
  console.info = (...a) => lines.push(a.join(" "));
  try { view._logSecurityAudit(view._effectiveSecurity()); } finally { console.info = orig; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /protectedMode=false/);
});

test("#29 (2, 13): confirm in the panel, then restart → bypassPermissions, no prompt (host has no _vaultRoot)", async () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, settings: { permissionMode: "bypassPermissions" } });
  assert.equal(typeof host._vaultRoot, "undefined");
  const view = makeView(host, { securityOverrides: EMBEDDER_OVERRIDES });
  const modal = view._maybePromptVaultSecurity();
  assert.ok(modal instanceof securityUi.ConfirmVaultSecurityModal);
  await modal.confirm();
  assert.equal(modal.isOpen, false);

  // "Restart": new session, new view, same machine store.
  securityUi._resetPromptedScopes();
  const after = makeView(makeHost({ app, settings: { permissionMode: "bypassPermissions" } }), { securityOverrides: EMBEDDER_OVERRIDES });
  const sec = after._effectiveSecurity();
  assert.equal(after._securitySpawnOptions(sec).permissionMode, "bypassPermissions");
  after._refreshPermBadge();
  assert.equal(after.permBtn.text, "YOLO ▾");
  const before = Modal.opened.length;
  const noticesBefore = Notice.shown.length;
  assert.equal(after._maybePromptVaultSecurity(), null);
  assert.equal(Modal.opened.length, before);
  assert.equal(Notice.shown.length, noticesBefore, "no Notice either");
});

test("#29 (3): a toolbar pick in the embedder panel writes the store and takes effect on the next spawn", async () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, settings: { permissionMode: "bypassPermissions" } });
  const view = makeView(host, { securityOverrides: EMBEDDER_OVERRIDES });
  store.setMachineSecuritySetting(store.resolveSecurityScope({ hostPlugin: host }), "permissionMode", "bypassPermissions");
  const proc = liveProcess(view);

  await view.changeSetting("permissionMode", "default", view.permBtn, PERMS);
  const scope = store.resolveSecurityScope({ hostPlugin: host });
  assert.equal(store.readMachineSecuritySettings(scope).permissionMode, "default");
  assert.equal(view._securitySpawnOptions(view._effectiveSecurity()).permissionMode, "default");
  assert.equal(proc.aborted, 1, "the live process is torn down so the next spawn re-snapshots");
  assert.equal(host.settings.permissionMode, "default", "mirrored into the host's settings (display only)");
  assert.ok(app._triggered.some((t) => t.name === "gryphon:security-settings-changed"));

  await view.changeSetting("permissionMode", "bypassPermissions", view.permBtn, PERMS);
  assert.equal(view._securitySpawnOptions(view._effectiveSecurity()).permissionMode, "bypassPermissions");
});

test("#29 (14): no app and no manifest → visible failure, protections forced on", async () => {
  freshConfigHome();
  const host = makeHost({ app: undefined, id: null, settings: { permissionMode: "bypassPermissions" } });
  const view = makeView(host);
  const noticesBefore = Notice.shown.length;
  const { errors } = await captureErrors(() => view.changeSetting("permissionMode", "bypassPermissions", view.permBtn, PERMS));
  const notices = Notice.shown.slice(noticesBefore).map((n) => n.message);
  assert.ok(notices.some((m) => /Can't save this security setting/.test(m)), notices.join("\n"));
  assert.ok(errors.length > 0, "console.error names what was missing");
  assert.equal(view._securitySpawnOptions(view._effectiveSecurity()).permissionMode, "default");
  view._refreshPermBadge();
  assert.match(view.permBtn.title, /protections forced on/);
  assert.equal(view._maybePromptVaultSecurity(), null, "no prompt: there's nothing it could save");
});

test("#29 (10): toolbar items for an overridden key are disabled with 'Set by <host>'", () => {
  freshConfigHome();
  const host = makeHost({ app: makeApp(vaultDir()) });
  const view = makeView(host, { securityOverrides: { permissionMode: "default" }, displayText: "HostApp" });
  const entries = view._permMenuEntries();
  assert.equal(entries.length, PERMS.length);
  assert.ok(entries.every((e) => e.disabled && e.tooltip === "Set by HostApp"));
  // Not overridden → enabled, checkmark on the effective mode.
  const plain = makeView(host)._permMenuEntries();
  assert.ok(plain.every((e) => !e.disabled));
  assert.ok(plain.find((e) => e.value === "default").title.endsWith("✓"));
});

// ── Gryphon case ────────────────────────────────────────────────────────

test("#29 (5): a vault shipping weakening values launches protected and prompts; confirm sticks; a copy asks again", async () => {
  freshConfigHome();
  const vault = vaultDir();
  const weak = { protectedMode: false, permissionMode: "bypassPermissions", protectedPathsDisabled: [".obsidian/plugins/gryphon/"] };
  const host = makeHost({ app: makeApp(vault), id: "gryphon", settings: weak });
  const view = makeView(host);
  const sec = view._effectiveSecurity();
  assert.equal(sec.protectedMode, true);
  assert.equal(sec.permissionMode, "default");
  const modal = view._maybePromptVaultSecurity();
  assert.ok(modal);
  assert.deepEqual([...modal.keys].sort(), ["permissionMode", "protectedMode", "protectedPathsDisabled"]);
  await modal.confirm();
  securityUi._resetPromptedScopes();
  const restarted = makeView(makeHost({ app: makeApp(vault), id: "gryphon", settings: weak }));
  assert.equal(restarted._effectiveSecurity().protectedMode, false);
  assert.equal(restarted._maybePromptVaultSecurity(), null);
  const copy = makeView(makeHost({ app: makeApp(vaultDir()), id: "gryphon", settings: weak }));
  assert.equal(copy._effectiveSecurity().protectedMode, true);
  assert.ok(copy._maybePromptVaultSecurity(), "a copied vault prompts again");
});

test("#29 (6): turning Protected Mode off in Settings persists with no prompt; back on also sticks", async () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, id: "gryphon", settings: {} });
  const parent = _el();
  renderSectionHeading(parent, { title: "Protected Mode", toggleKey: "protectedMode" }, host);
  const toggle = _allSettings(parent)[0].controls[0];
  assert.equal(toggle.value, true);
  await toggle.changeHandler(false);
  securityUi._resetPromptedScopes();
  const restarted = makeHost({ app, id: "gryphon", settings: { ...host.settings } });
  assert.equal(restarted.settings.protectedMode, false, "mirror written");
  const view = makeView(restarted);
  assert.equal(view._effectiveSecurity().protectedMode, false);
  assert.equal(view._maybePromptVaultSecurity(), null, "the user's own choice never prompts");
  await view.applySecuritySetting("protectedMode", true);
  assert.equal(makeView(makeHost({ app, id: "gryphon", settings: { protectedMode: false } }))._effectiveSecurity().protectedMode, true);
});

test("#29 (7): 'Keep protections on' → no re-prompt on restart; a different weakening value re-prompts once", () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, id: "gryphon", settings: { permissionMode: "bypassPermissions" } });
  const modal = makeView(host)._maybePromptVaultSecurity();
  modal.keepProtections();
  securityUi._resetPromptedScopes();
  assert.equal(makeView(makeHost({ app, id: "gryphon", settings: { permissionMode: "bypassPermissions" } }))._maybePromptVaultSecurity(), null);
  securityUi._resetPromptedScopes();
  const changed = makeView(makeHost({ app, id: "gryphon", settings: { permissionMode: "acceptEdits" } }));
  assert.ok(changed._maybePromptVaultSecurity());
  assert.equal(changed._maybePromptVaultSecurity(), null, "once per session");
});

test("#29: Esc/close defers — the next app start asks again", () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, id: "gryphon", settings: { protectedMode: false } });
  const modal = makeView(host)._maybePromptVaultSecurity();
  modal.close();
  securityUi._resetPromptedScopes();
  assert.ok(makeView(host)._maybePromptVaultSecurity());
});

// ── per-host isolation (item 15) ────────────────────────────────────────

test("#29 (15): YOLO in one host's panel leaves the other host's mode alone", async () => {
  freshConfigHome();
  const vault = vaultDir();
  const gryphon = makeView(makeHost({ app: makeApp(vault), id: "gryphon", settings: { permissionMode: "acceptEdits" } }));
  const other = makeView(makeHost({ app: makeApp(vault), id: "other-fixture", settings: { permissionMode: "bypassPermissions" } }));
  await gryphon.changeSetting("permissionMode", "bypassPermissions", gryphon.permBtn, PERMS);
  assert.equal(gryphon._effectiveSecurity().permissionMode, "bypassPermissions");
  assert.equal(other._effectiveSecurity().permissionMode, "default");
  await other.changeSetting("permissionMode", "plan", other.permBtn, PERMS);
  assert.equal(gryphon._effectiveSecurity().permissionMode, "bypassPermissions");
  // Confirming in one host leaves the other's prompt pending.
  const fresh = makeView(makeHost({ app: makeApp(vault), id: "third", settings: { permissionMode: "bypassPermissions" } }));
  assert.deepEqual([...fresh._effectiveSecurity().unconfirmed], ["permissionMode"]);
});

// ── the renderer (item 16) ──────────────────────────────────────────────

test("#29 (16): renderDefaultsPanel shows the effective mode, writes the store, refreshes an open view", async () => {
  freshConfigHome();
  const app = makeApp(vaultDir());
  const host = makeHost({ app, settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6", permissionMode: "bypassPermissions" } });
  const sec = { securityOverrides: { protectedMode: false } };

  // An open view subscribed to the scoped event, with a live process.
  const view = makeView(host, sec);
  app.workspace.on("gryphon:security-settings-changed", (scope) => view._onSecuritySettingsChanged(scope));
  const proc = liveProcess(view);

  const panel = _el();
  renderDefaultsPanel(host, panel, { rerenderSelf() {} }, sec);
  const rows = _allSettings(panel);
  const drop = rows.find((r) => r.name === "Default permissions").controls[0];
  assert.equal(drop.value, "default", "the dropdown shows the effective value, not data.json");
  const unconfirmedRow = rows.find((r) => r.controls.some((c) => c.buttonText === "Confirm…"));
  assert.ok(unconfirmedRow, "an unconfirmed row offers Confirm…");

  await drop.changeHandler("bypassPermissions");
  const scope = store.resolveSecurityScope({ hostPlugin: host });
  assert.equal(store.readMachineSecuritySettings(scope).permissionMode, "bypassPermissions");
  assert.equal(proc.aborted, 1, "the open view tore down its process via gryphon:security-settings-changed");
  view._refreshPermBadge();
  assert.equal(view.permBtn.text, "YOLO ▾");
  assert.equal(view._securitySpawnOptions(view._effectiveSecurity()).permissionMode, "bypassPermissions");
});

test("#29 (16): a key set by the host's securityOverrides is shown disabled", () => {
  freshConfigHome();
  const host = makeHost({ app: makeApp(vaultDir()), settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" } });
  const panel = _el();
  renderDefaultsPanel(host, panel, { rerenderSelf() {} }, { securityOverrides: { permissionMode: "plan" } });
  const drop = _allSettings(panel).find((r) => r.name === "Default permissions").controls[0];
  assert.equal(drop.value, "plan");
  assert.equal(drop.disabled, true);
});

test("#29: a security event for another scope doesn't touch this view", () => {
  freshConfigHome();
  const host = makeHost({ app: makeApp(vaultDir()) });
  const view = makeView(host);
  const proc = liveProcess(view);
  store.setMachineSecuritySetting(store.resolveSecurityScope({ hostPlugin: host }), "permissionMode", "plan");
  view._onSecuritySettingsChanged({ vaultKey: "/elsewhere", hostId: "fixture" });
  assert.equal(proc.aborted, 0);
  view._onSecuritySettingsChanged(store.resolveSecurityScope({ hostPlugin: host }));
  assert.equal(proc.aborted, 1, "the spawn signature carries the effective values");
});
