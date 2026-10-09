/**
 * Security settings, host side (issue #29, Design rev 3).
 *
 * Every UI write of a weakening key — the toolbar picker, `/perm`, the REST
 * chip, Settings (Gryphon's own tab and the host-agnostic renderer an
 * embedder draws), the confirm prompt — goes through `applySecuritySetting`.
 * It writes the machine-local store in `@gryphon/protect` (outside the
 * vault), mirrors the value into the host's settings for display continuity
 * (never enforced), and announces the change on the workspace bus.
 *
 * `host` is the minimal embedding contract `{ settings, saveSettings, app?,
 * manifest? }`. The store scope comes from `app.vault.adapter` and an
 * explicit `hostId` or the host's code-set `securityHostId` — never
 * `manifest.id` (#30, G3); with no scope a write throws
 * `SecurityScopeUnavailableError` and the caller shows why. A confirm is
 * never dropped silently.
 */

const { Modal, Setting, Notice } = require("obsidian");
const { securitySettings, mcpApprovals } = require("@gryphon/protect");

const {
  WEAKENING_KEYS,
  SecurityScopeUnavailableError,
  describeSecurityScope,
  scopeKey,
  isWeakeningKey,
  isExecutableKey,
  validateSecurityValue,
  validateCliPath,
  setMachineSecuritySetting,
  setMachineCliPath,
  dismissVaultSecuritySuggestion,
  effectiveSecuritySettings,
  onSecurityStoreError,
  onSecurityStoreTamper,
  CLI_PATH_KEY_BY_KIND,
} = securitySettings;

/** Issue #30: human names for the CLI path keys. */
const CLI_PATH_LABELS: Record<string, string> = {
  claudePath: "Claude Code",
  codexPath: "Codex CLI",
  geminiCliPath: "Gemini CLI",
  antigravityPath: "Antigravity CLI",
};
function cliPathLabel(key: string): string {
  return CLI_PATH_LABELS[key] || key;
}
/** Issue #30: the CLI kind a path key belongs to. */
function cliKindForPathKey(key: string): string | null {
  for (const [kind, k] of Object.entries(CLI_PATH_KEY_BY_KIND as Record<string, string>)) if (k === key) return kind;
  return null;
}

const SECURITY_CHANGED_EVENT = "gryphon:security-settings-changed";

type Host = { settings: any; saveSettings(): any; app?: any; manifest?: { id?: string; name?: string } };
type ApplyOpts = { app?: any; hostId?: string; overrides?: Record<string, unknown> | null };

const KEY_LABELS: Record<string, string> = {
  protectedMode: "Protected Mode",
  permissionMode: "Permission mode",
  protectedPathsEnabled: "Protect file paths",
  protectedCommandsEnabled: "Protect commands",
  blockPackageInstall: "Block package installation",
  protectedPathsDisabled: "Built-in protected paths turned off",
  protectedCommandsDisabled: "Built-in protected commands turned off",
  claudeCodeInheritUserConfig: "Use my personal Claude Code configuration",
  obsidianRestApiPolicy: "Obsidian REST API access",
};

const PERM_LABELS: Record<string, string> = {
  default: "Prompt", acceptEdits: "Safe", bypassPermissions: "YOLO", plan: "Plan",
};

/** Human label for a weakening key. */
function securityKeyLabel(key: string): string {
  return KEY_LABELS[key] || key;
}

/** Human, display-safe rendering of a value a vault file requests. */
function describeSecurityValue(key: string, value: unknown): string {
  let text: string;
  if (key === "permissionMode") text = PERM_LABELS[String(value)] || String(value);
  else if (key === "obsidianRestApiPolicy") text = value === "allowed" ? "allowed" : "blocked";
  else if (typeof value === "boolean") text = value ? "on" : "off";
  else if (Array.isArray(value)) text = value.length ? value.join(", ") : "none";
  else text = JSON.stringify(value);
  return mcpApprovals.displaySafe(text);
}

function hostDisplayName(host: Host, hostId?: string | null): string {
  const name = (host && host.manifest && (host.manifest.name || host.manifest.id)) || hostId || "this plugin";
  return mcpApprovals.displaySafe(name);
}

function _hasOwn(o: any, k: string): boolean {
  return !!o && Object.prototype.hasOwnProperty.call(o, k);
}

function securityScopeFor(host: Host, opts: ApplyOpts = {}) {
  return describeSecurityScope({ app: opts.app || (host && host.app), hostPlugin: host, hostId: opts.hostId });
}

/** The effective snapshot for a host (what enforcement and badges read). */
function effectiveSecurityFor(host: Host, opts: ApplyOpts = {}) {
  const { scope } = securityScopeFor(host, opts);
  return effectiveSecuritySettings((host && host.settings) || {}, scope, opts.overrides || undefined);
}

/**
 * Write one weakening key from a user gesture on this machine.
 *   1. resolve the scope (throws SecurityScopeUnavailableError without one);
 *   2. validate; 3. write the store (both directions);
 *   4. mirror into host.settings + saveSettings() (display only);
 *   5. trigger `gryphon:security-settings-changed` on the workspace bus.
 * The caller's view tears down its live process (the spawn signature
 * carries the effective values, so a mismatch respawns on next message).
 */
async function applySecuritySetting(host: Host, key: string, value: unknown, opts: ApplyOpts = {}) {
  const { scope, missing } = securityScopeFor(host, opts);
  if (!scope) {
    console.error(`[gryphon] security setting ${key} not saved: no ${missing} to scope it to`);
    throw new SecurityScopeUnavailableError(missing);
  }
  if (!isWeakeningKey(key)) throw new Error(`Gryphon: ${key} isn't a security setting`);
  if (_hasOwn(opts.overrides, key)) {
    throw new Error(`Gryphon: ${securityKeyLabel(key)} is set by ${hostDisplayName(host, scope.hostId)} and can't be changed here.`);
  }
  const v = validateSecurityValue(key, value);
  if (!v.ok) throw new Error(`Gryphon: ${v.reason}`);
  setMachineSecuritySetting(scope, key, v.value);
  if (host && host.settings) host.settings[key] = Array.isArray(v.value) ? [...v.value] : v.value;
  try {
    if (host && typeof host.saveSettings === "function") await host.saveSettings();
  } catch (e) {
    // The store is the source of truth; the data.json mirror is cosmetic.
    console.error("[gryphon] security setting saved on this machine, but the settings file write failed:", e);
  }
  const app = opts.app || (host && host.app);
  try { app?.workspace?.trigger?.(SECURITY_CHANGED_EVENT, scope, key); } catch { /* best-effort */ }
  return scope;
}

/**
 * Issue #30: store a CLI binary path from a user gesture on this machine
 * (Settings row, the confirm prompt). Validates (throws CliPathRejectedError
 * with the reason), writes the machine store under the host's scope, mirrors
 * the value into the host's settings for display continuity (never a spawn
 * input), and announces the change. `value` "" / null clears it.
 */
async function applyCliPathSetting(host: Host, key: string, value: string | null, opts: ApplyOpts = {}) {
  const { scope, missing } = securityScopeFor(host, opts);
  if (!scope) throw new SecurityScopeUnavailableError(missing);
  if (!isExecutableKey(key)) throw new Error(`Gryphon: ${key} isn't a CLI path setting`);
  const ov = opts.overrides && (opts.overrides as any).paths;
  if (ov && _hasOwn(ov, key)) {
    throw new Error(`Gryphon: the ${cliPathLabel(key)} location is set by ${hostDisplayName(host, scope.hostId)} and can't be changed here.`);
  }
  setMachineCliPath(scope, key, value);
  const v = typeof value === "string" ? value.trim() : "";
  if (host && host.settings) host.settings[key] = v;
  try {
    if (host && typeof host.saveSettings === "function") await host.saveSettings();
  } catch (e) {
    console.error("[gryphon] CLI path saved on this machine, but the settings file write failed:", e);
  }
  const app = opts.app || (host && host.app);
  try { app?.workspace?.trigger?.(SECURITY_CHANGED_EVENT, scope, key); } catch { /* best-effort */ }
  return scope;
}

/** Issue #30: one Notice per rejected stored path (it falls back to detection). */
const _reportedRejections = new Set<string>();
function reportCliPathRejected(rejected: { key: string; value: string; reason: string }) {
  const tag = `${rejected.key}\u0000${rejected.value}\u0000${rejected.reason}`;
  if (_reportedRejections.has(tag)) return;
  _reportedRejections.add(tag);
  const why: Record<string, string> = {
    "missing": "it no longer exists",
    "inside-vault": "it's inside this vault",
    "not-executable": "it isn't executable",
    "not-a-file": "it's a folder",
    "relative": "it isn't a full path",
    "too-old": "that version is too old",
  };
  const msg =
    `Gryphon isn't using the ${cliPathLabel(rejected.key)} location you confirmed ` +
    `(${mcpApprovals.displaySafe(rejected.value)}): ${why[rejected.reason] || rejected.reason}. ` +
    "It's using the one it detected instead. Set a new location in Settings → Gryphon.";
  console.warn("[gryphon]", msg);
  try { new Notice(msg, 15000); } catch { /* headless */ }
}

/**
 * Issue #30 (G2): the turn-end tamper check undid weakening changes to
 * Gryphon's security settings that something other than Gryphon made
 * during a reply. Always visible.
 */
/** QA (2.11.2): at most `max` names, then "and N more" — a planted file can hold thousands. */
function _capList(items: string[], max = 8): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** Review: one name can be planted at any length — shorten it. */
function _short(s: string, max = 60): string {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A vault's folder name for a notice (the store is keyed by full path). */
function _vaultName(vaultKey: string, segments = 1): string {
  const parts = String(vaultKey || "").split(/[\\/]+/).filter(Boolean);
  const name = parts.length ? parts.slice(-segments).join("/") : String(vaultKey || "");
  return mcpApprovals.displaySafe(_short(name));
}

/** Items grouped by vault: `a, b (vault "X"); c (vault "Y")`, capped. */
function _byVault(items: Array<{ vaultKey: string; label: string }>): string {
  const groups = new Map<string, Set<string>>();
  for (const it of items) {
    const k = String(it.vaultKey || "");
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)!.add(_short(it.label));
  }
  // Two vaults with the same folder name are told apart by their parent folder.
  const counts = new Map<string, number>();
  for (const k of groups.keys()) counts.set(_vaultName(k), (counts.get(_vaultName(k)) || 0) + 1);
  const parts = [...groups].map(([k, labels]) => {
    const v = (counts.get(_vaultName(k)) || 0) > 1 ? _vaultName(k, 2) : _vaultName(k);
    return `${_capList([...labels])} (vault "${v}")`;
  });
  return parts.length > 4 ? `${parts.slice(0, 4).join("; ")}; and ${parts.length - 4} more vaults` : parts.join("; ");
}

function _tamperNames(reverted: Array<{ key: string }>): string[] {
  return [...new Set(reverted.map((r) => {
    const k = r.key.replace(/^(paths|dismissed)\./, "");
    return isExecutableKey(k) ? `${cliPathLabel(k)} location` : securityKeyLabel(k);
  }))];
}

function reportSecurityTamperReverted(reverted: Array<{ hostId: string; key: string }>, providerLabel: string | null) {
  const names = _tamperNames(reverted);
  const when = providerLabel === null
    ? "outside Gryphon"
    : `during ${mcpApprovals.displaySafe(providerLabel)}'s reply`;
  const msg =
    `Gryphon undid a change to its security settings made ${when} ` +
    `(${[...new Set(names)].join(", ")}). Only Gryphon's settings screen can change these.`;
  console.warn("[gryphon]", msg, reverted);
  try { new Notice(msg, 15000); } catch { /* headless */ }
}

/**
 * R43-10: the turn-end check found a change to the security settings but
 * couldn't put it back. Nothing was undone, so the user must look.
 */
function reportSecurityTamperUndoFailed(providerLabel: string | null, e: any) {
  const when = providerLabel === null
    ? "made outside Gryphon"
    : `during ${mcpApprovals.displaySafe(providerLabel)}'s reply`;
  const using = providerLabel === null ? " Until it's fixed, Gryphon uses the settings it last saved." : "";
  const msg =
    `Gryphon found a change to its security settings ${when} ` +
    `but couldn't undo it${e && e.code ? ` (${mcpApprovals.displaySafe(String(e.code))})` : ""}.${using} ` +
    "Open Gryphon's Security settings to check them, and make sure the settings file can be written.";
  console.error("[gryphon]", msg, e);
  try { new Notice(msg, 0); } catch { /* headless */ }
}

/** The Notice + log a caller shows when a security write fails. */
function reportSecurityWriteError(e: any) {
  const msg = e instanceof SecurityScopeUnavailableError
    ? "Can't save this security setting: Gryphon couldn't identify this vault/host. Protections stay on."
    : `Couldn't save this security setting: ${(e && e.message) || e}`;
  console.error("[gryphon]", msg, e && e.missing ? `(missing: ${e.missing})` : "");
  try { new Notice(msg, 10000); } catch { /* obsidian unavailable */ }
  return msg;
}

/** Store read errors surface as a Notice naming the file (once per error). */
let _storeErrorSinkInstalled = false;
function installSecurityStoreErrorNotice() {
  if (_storeErrorSinkInstalled) return;
  _storeErrorSinkInstalled = true;
  onSecurityStoreError((message: string) => {
    try { new Notice(`Gryphon: ${mcpApprovals.displaySafe(message)}`, 15000); } catch { /* headless */ }
  });
  // Issue #32: a change found when the settings are next read — after a
  // reply ended, or across a restart — not by a reply's own check.
  onSecurityStoreTamper((reverted: Array<{ hostId: string; key: string }>, error: any, info?: string) => {
    if (info === "record-started") {
      // QA P2-A: name what the adopted settings loosen, so the user knows what to check.
      // The store is machine-wide: say which vault each setting belongs to.
      const items = reverted.map((r: any) => ({ vaultKey: r.vaultKey, label: _tamperNames([r])[0] }));
      const msg =
        "Gryphon now keeps a record of its security settings so it can undo changes made outside Gryphon. " +
        (items.length
          ? `It started from the settings as they are now, which loosen protection: ${_byVault(items)}. ` +
            "If you didn't choose these, open that vault and change them in Gryphon's Security settings."
          : "It started from the settings as they are now; open Gryphon's Security settings if anything looks wrong.");
      console.warn("[gryphon]", msg);
      try { new Notice(msg, 15000); } catch { /* headless */ }
    } else if (error) reportSecurityTamperUndoFailed(null, error);
    else reportSecurityTamperReverted(reverted, null);
  });
  // Issue #32: the same for MCP server approvals (they let a vault's server
  // start without asking). The removal holds even if it couldn't be saved.
  mcpApprovals.onApprovalsTamper((removed: Array<{ name: string }>, error: any, info?: string) => {
    if (info === "record-started") {
      const items = removed.map((r: any) => ({ vaultKey: r.vaultKey, label: mcpApprovals.displaySafe(_short(r.name)) }));
      const msg =
        "Gryphon now keeps a record of the MCP servers you approved so it can ignore approvals added outside Gryphon. " +
        `It started from the approvals as they are now${items.length ? ` (${_byVault(items)})` : ""}; ` +
        "in each vault, check Approved vault MCP servers in Gryphon's settings for any server you didn't approve.";
      console.warn("[gryphon]", msg);
      try { new Notice(msg, 15000); } catch { /* headless */ }
      return;
    }
    const names = _capList([...new Set(removed.map((r) => mcpApprovals.displaySafe(_short(r.name))))]);
    const msg =
      `Gryphon ignored MCP server approvals added outside Gryphon (${names}). ` +
      "Those servers will ask before they start." +
      (error ? " Gryphon couldn't remove them from the approvals file; make sure it can be written." : "");
    console.warn("[gryphon]", msg, error || "");
    try { new Notice(msg, error ? 0 : 15000); } catch { /* headless */ }
  });
}

/**
 * The confirm prompt: lists each unconfirmed key with the value the vault's
 * settings file asks for.
 *   Use these settings on this machine → applySecuritySetting for each key.
 *   Keep protections on → dismissed until data.json brings a different value.
 *   Esc / close → protections stay on for this app session only.
 */
class ConfirmVaultSecurityModal extends Modal {
  host: Host;
  scope: any;
  keys: string[];
  pathKeys: string[];
  opts: ApplyOpts & { onDone?: (outcome: "confirmed" | "dismissed") => void };

  constructor(
    app: any, host: Host, scope: any, unconfirmed: string[],
    opts: ApplyOpts & { onDone?: (outcome: "confirmed" | "dismissed") => void } = {},
    unconfirmedPaths: string[] = [],
  ) {
    super(app);
    this.host = host;
    this.scope = scope;
    this.keys = unconfirmed.filter((k) => isWeakeningKey(k));
    // Issue #30: CLI binary locations the vault's settings file names.
    this.pathKeys = unconfirmedPaths.filter((k) => isExecutableKey(k));
    this.opts = opts;
  }

  open() {
    this._render();
    super.open();
  }

  _render() {
    const name = hostDisplayName(this.host, this.scope && this.scope.hostId);
    this.titleEl.setText(`Confirm this vault's security settings for ${name}`);
    const c = this.contentEl;
    c.empty?.();
    c.createEl("p", {
      text:
        `This vault's settings file asks ${name} to run with weaker protection. Settings files ` +
        "travel with a vault, so a shared, synced or cloned vault could set these without you. " +
        "Until you confirm them on this machine, protections stay on.",
    });
    const list = c.createEl("ul");
    for (const key of this.keys) {
      list.createEl("li", {
        text: `${securityKeyLabel(key)}: ${describeSecurityValue(key, this.host.settings && this.host.settings[key])}`,
      });
    }
    // Issue #30: a CLI location is a program Gryphon would run. Show the
    // full path it resolves to, and say so plainly when it can't be used.
    for (const key of this.pathKeys) {
      const value = this.host.settings && this.host.settings[key];
      const v = validateCliPath(value, this.scope && this.scope.vaultKey);
      const shown = mcpApprovals.displaySafe(v.ok ? v.real : String(value));
      let text = `${cliPathLabel(key)} program: ${shown}`;
      if (!v.ok && v.reason === "inside-vault") text += " — this file is inside this vault, so Gryphon won't run it.";
      else if (!v.ok) text += " — Gryphon can't use this location.";
      list.createEl("li", { text });
    }
    new Setting(c)
      .addButton((btn: any) => btn.setButtonText("Use these settings on this machine").setWarning().onClick(() => {
        void this.confirm();
      }))
      .addButton((btn: any) => btn.setButtonText("Keep protections on").setCta().onClick(() => {
        this.keepProtections();
      }));
  }

  async confirm() {
    try {
      for (const key of this.keys) {
        await applySecuritySetting(this.host, key, this.host.settings && this.host.settings[key], this.opts);
      }
      for (const key of this.pathKeys) {
        await applyCliPathSetting(this.host, key, this.host.settings && this.host.settings[key], this.opts);
      }
      this.close();
      if (this.opts.onDone) this.opts.onDone("confirmed");
    } catch (e) {
      reportSecurityWriteError(e);
    }
  }

  keepProtections() {
    try {
      for (const key of [...this.keys, ...this.pathKeys]) {
        dismissVaultSecuritySuggestion(this.scope, key, this.host.settings && this.host.settings[key]);
      }
      this.close();
      if (this.opts.onDone) this.opts.onDone("dismissed");
    } catch (e) {
      reportSecurityWriteError(e);
    }
  }
}

/** One prompt per scope per app session, however many views are open. */
const _promptedScopes = new Set<string>();

/**
 * Open the confirm prompt if this host's scope has unconfirmed weakening
 * values and it hasn't been shown this session. `force` (the ⚠ badge click,
 * Settings' Confirm… row) reopens it regardless. Returns the modal or null.
 */
function maybePromptVaultSecurity(app: any, host: Host, opts: ApplyOpts & { force?: boolean; onDone?: (o: "confirmed" | "dismissed") => void } = {}) {
  const { scope } = securityScopeFor(host, opts);
  if (!scope) return null;
  const eff = effectiveSecuritySettings((host && host.settings) || {}, scope, opts.overrides || undefined);
  if (!eff.unconfirmed.length && !eff.unconfirmedPaths.length) return null;
  const key = scopeKey(scope) as string;
  if (!opts.force && _promptedScopes.has(key)) return null;
  _promptedScopes.add(key);
  const modal = new ConfirmVaultSecurityModal(app || host.app, host, scope, [...eff.unconfirmed], opts, [...eff.unconfirmedPaths]);
  modal.open();
  return modal;
}

/** Test seam: forget which scopes were prompted this session. */
function _resetPromptedScopes() {
  _promptedScopes.clear();
}

module.exports = {
  WEAKENING_KEYS,
  SECURITY_CHANGED_EVENT,
  SecurityScopeUnavailableError,
  applySecuritySetting,
  applyCliPathSetting,
  reportCliPathRejected,
  reportSecurityTamperReverted,
  reportSecurityTamperUndoFailed,
  cliPathLabel,
  cliKindForPathKey,
  reportSecurityWriteError,
  installSecurityStoreErrorNotice,
  securityScopeFor,
  effectiveSecurityFor,
  securityKeyLabel,
  describeSecurityValue,
  hostDisplayName,
  ConfirmVaultSecurityModal,
  maybePromptVaultSecurity,
  _resetPromptedScopes,
};
