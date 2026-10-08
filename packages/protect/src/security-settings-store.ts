// TypeScript module marker.

/**
 * Machine-local security settings (issue #29, Design rev 3).
 *
 * Gryphon's `data.json` lives at `<vault>/.obsidian/plugins/<host>/` and
 * travels with the vault, so a shared, synced or cloned vault could ship
 * `protectedMode:false` or `permissionMode:"bypassPermissions"` and have
 * them treated as the user's own choice. The rule: a file inside the vault
 * can add protection but never remove it. A value that weakens protection
 * comes from exactly two places:
 *
 *   1. consumer code — the embedding view's `securityOverrides`;
 *   2. this store, outside every vault, written by a user gesture on this
 *      machine (toolbar, Settings, the confirm prompt).
 *
 *   effective[key] = overrides[key] ?? store[vaultKey].hosts[hostId][key] ?? DEFAULT[key]
 *
 * data.json is never an enforcement input for these keys. It's read only to
 * work out which of its weakening values haven't been confirmed here yet
 * (`unconfirmed`), so the chat view can offer them once.
 *
 *   <approvalsDir>/security-settings.json  (next to mcp-approvals.json)
 *   { "version": 1,
 *     "vaults": { "<realpath(vault)>": { "hosts": { "<manifest id>":
 *       { "values": {...}, "setAt": "ISO", "dismissed": { "<key>": "<sha256>" } } } } } }
 *
 * Per host, so a YOLO pick in Gryphon's panel never becomes the effective
 * mode of another plugin's panel in the same vault. The directory is
 * already covered by the approvals-store guardrail (file tools, shell
 * patterns and the claude-code deny globs), in every permission mode.
 *
 * Fails closed: a missing file is empty; an unreadable or malformed one is
 * empty AND reported; a value that fails validation is dropped. In every
 * case the key resolves to its protected default.
 *
 * Issue #30 adds three things on the same model:
 *   - CLI binary paths (`EXECUTABLE_KEYS`) live here too, under
 *     `hosts[hostId].paths`, and every spawn resolves through
 *     `resolveCliPath` (override → this store → detection). A path inside
 *     the vault is refused outright, even with a confirmation: sync could
 *     swap the binary later.
 *   - the host id has no manifest fallback: an embedder that doesn't pin
 *     `securityHostId` gets no scope (protections stay on, writes raise).
 *   - every write is recorded in a renderer-global ledger, so the chat
 *     view's turn-end tamper check can tell Gryphon's own writes from an
 *     agent's and revert only the latter's weakening changes.
 */

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const os = require("os") as typeof import("os");
const crypto = require("crypto") as typeof import("crypto");
const mcpApprovals = require("./mcp-approvals");
const { DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS } = require("./constants");

const STORE_VERSION = 1;
const FILE_NAME = "security-settings.json";
const HASH_RE = /^[0-9a-f]{64}$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** The closed set. `autoDenyProtected` is NOT here: both values enforce. */
const WEAKENING_KEYS = Object.freeze([
  "protectedMode",
  "permissionMode",
  "protectedPathsEnabled",
  "protectedCommandsEnabled",
  "blockPackageInstall",
  "protectedPathsDisabled",
  "protectedCommandsDisabled",
  "claudeCodeInheritUserConfig",
  "obsidianRestApiPolicy",
] as const);

type WeakeningKey = typeof WEAKENING_KEYS[number];
type SecurityValues = Partial<Record<WeakeningKey, any>>;
type SecurityScope = { vaultKey: string; hostId: string };
type Source = "override" | "machine" | "default";

const DEFAULTS: Readonly<Record<WeakeningKey, any>> = Object.freeze({
  protectedMode: true,
  permissionMode: "default",
  protectedPathsEnabled: true,
  protectedCommandsEnabled: true,
  blockPackageInstall: true,
  protectedPathsDisabled: Object.freeze([]),
  protectedCommandsDisabled: Object.freeze([]),
  claudeCodeInheritUserConfig: false,
  obsidianRestApiPolicy: "blocked",
});

const PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan"]);
const BOOLEAN_KEYS = new Set<string>(["protectedMode", "protectedPathsEnabled", "protectedCommandsEnabled", "blockPackageInstall", "claudeCodeInheritUserConfig"]);
const KEY_SET = new Set<string>(WEAKENING_KEYS);

/** Issue #30: the CLI binary paths — machine-scoped, never read from data.json. */
const EXECUTABLE_KEYS = Object.freeze(["claudePath", "codexPath", "geminiCliPath", "antigravityPath"] as const);
type ExecutableKey = typeof EXECUTABLE_KEYS[number];
const EXECUTABLE_KEY_SET = new Set<string>(EXECUTABLE_KEYS);
const CLI_PATH_KEY_BY_KIND: Readonly<Record<string, ExecutableKey>> = Object.freeze({
  "claude-code": "claudePath",
  "codex-cli": "codexPath",
  "gemini-cli": "geminiCliPath",
  "antigravity-cli": "antigravityPath",
});

function isExecutableKey(key: unknown): key is ExecutableKey {
  return typeof key === "string" && EXECUTABLE_KEY_SET.has(key);
}

function _patternsOf(defs: any[]): Set<string> {
  return new Set(defs.map((d) => (typeof d === "string" ? d : d && d.pattern)).filter((p) => typeof p === "string"));
}
const KNOWN_DISABLED: Record<string, Set<string>> = {
  protectedPathsDisabled: _patternsOf(DEFAULT_PROTECTED_PATHS),
  protectedCommandsDisabled: _patternsOf(DEFAULT_PROTECTED_COMMANDS),
};

function isWeakeningKey(key: unknown): key is WeakeningKey {
  return typeof key === "string" && KEY_SET.has(key);
}

/**
 * `{ ok: true, value }` with the normalized value, or `{ ok: false, reason }`.
 * A `*Disabled` list keeps only entries naming a built-in pattern: disabling
 * a pattern that doesn't exist does nothing, so dropping it changes nothing.
 */
function validateSecurityValue(key: unknown, value: unknown): { ok: true; value: any } | { ok: false; reason: string } {
  if (!isWeakeningKey(key)) return { ok: false, reason: `unknown key ${JSON.stringify(key)}` };
  if (BOOLEAN_KEYS.has(key)) {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: `${key} must be true or false` };
  }
  if (key === "permissionMode") {
    return typeof value === "string" && PERMISSION_MODES.has(value)
      ? { ok: true, value }
      : { ok: false, reason: `unknown permissionMode ${JSON.stringify(value)}` };
  }
  if (key === "obsidianRestApiPolicy") {
    return value === "blocked" || value === "allowed"
      ? { ok: true, value }
      : { ok: false, reason: `obsidianRestApiPolicy must be "blocked" or "allowed"` };
  }
  // protectedPathsDisabled / protectedCommandsDisabled
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { ok: false, reason: `${key} must be a list of built-in patterns` };
  }
  const known = KNOWN_DISABLED[key];
  return { ok: true, value: [...new Set(value.filter((p) => known.has(p)))] };
}

/** True when `value` removes protection relative to the default. */
function isWeakening(key: WeakeningKey, value: unknown): boolean {
  const v = validateSecurityValue(key, value);
  if (!v.ok) return false;
  switch (key) {
    case "protectedMode":
    case "protectedPathsEnabled":
    case "protectedCommandsEnabled":
    case "blockPackageInstall":
      return v.value === false;
    case "permissionMode":
      return v.value !== "default";
    case "protectedPathsDisabled":
    case "protectedCommandsDisabled":
      return v.value.length > 0;
    case "claudeCodeInheritUserConfig":
      return v.value === true;
    case "obsidianRestApiPolicy":
      return v.value === "allowed";
  }
}

function hashValue(value: unknown): string {
  return mcpApprovals.hashSpec(value);
}

function securitySettingsFilePath(opts: { platform?: string; env?: Record<string, string | undefined>; homedir?: string } = {}): string {
  const dir = mcpApprovals.approvalsDir(opts);
  return (opts.platform || process.platform) === "win32" ? path.win32.join(dir, FILE_NAME) : path.join(dir, FILE_NAME);
}

// ── scope ──────────────────────────────────────────────────────────────

class SecurityScopeUnavailableError extends Error {
  missing: "app" | "basePath" | "hostId";
  constructor(missing: "app" | "basePath" | "hostId") {
    super(
      "Can't save this security setting: Gryphon couldn't identify this vault/host. Protections stay on." +
      ` (missing: ${missing})`,
    );
    this.name = "SecurityScopeUnavailableError";
    this.missing = missing;
  }
}

function _validName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !RESERVED_NAMES.has(v);
}

/**
 * The store scope for a host, or why there isn't one. Uses the host's
 * `app.vault.adapter` base path and its manifest id — never
 * `_vaultRoot()`, which embedders don't have.
 */
function describeSecurityScope(input: { app?: any; hostPlugin?: any; hostId?: string } = {}):
  { scope: SecurityScope; missing: null } | { scope: null; missing: "app" | "basePath" | "hostId" } {
  const app = input.app || (input.hostPlugin && input.hostPlugin.app);
  if (!app) return { scope: null, missing: "app" };
  const adapter = app.vault && app.vault.adapter;
  let basePath: unknown = null;
  try {
    basePath = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter && adapter.basePath;
  } catch (_) { basePath = null; }
  if (typeof basePath !== "string" || !basePath) return { scope: null, missing: "basePath" };
  // Host id precedence: explicit option > the host's own code-set
  // `securityHostId`. Never manifest.id (issue #30, G3): the manifest ships
  // inside the vault (.obsidian/plugins/<dir>/manifest.json), so a vault
  // could rename it to another host's id and inherit that host's confirmed
  // weakening values. With neither, there's no scope and reads fail closed.
  const hp = input.hostPlugin;
  const hostId = input.hostId !== undefined && input.hostId !== null
    ? input.hostId
    : (hp && typeof hp.securityHostId === "string" && hp.securityHostId) || null;
  if (!_validName(hostId)) return { scope: null, missing: "hostId" };
  return { scope: { vaultKey: mcpApprovals.vaultKey(basePath), hostId }, missing: null };
}

function resolveSecurityScope(input: { app?: any; hostPlugin?: any; hostId?: string } = {}): SecurityScope | null {
  return describeSecurityScope(input).scope;
}

function scopeKey(scope: SecurityScope | null): string | null {
  return scope ? `${scope.vaultKey}\u0000${scope.hostId}` : null;
}

// ── file I/O ───────────────────────────────────────────────────────────

interface HostEntry { values: SecurityValues; setAt: string; dismissed: Record<string, string>; paths: Partial<Record<ExecutableKey, string>> }
interface Store { version: number; vaults: Record<string, { hosts: Record<string, HostEntry> }> }

const _errorSinks = new Set<(message: string, file: string) => void>();
const _reported = new Set<string>();

/**
 * Register a sink for store read errors (the plugin shows a Notice). Each
 * distinct error is reported once per file version. Returns an unsubscribe.
 */
function onSecurityStoreError(fn: (message: string, file: string) => void): () => void {
  _errorSinks.add(fn);
  return () => { _errorSinks.delete(fn); };
}

function _report(file: string, stamp: string, message: string) {
  console.error(`[gryphon/security-settings] ${message}`);
  const key = `${file}\u0000${stamp}\u0000${message}`;
  if (_reported.has(key)) return;
  _reported.add(key);
  for (const fn of _errorSinks) {
    try { fn(message, file); } catch (_) { /* a sink must not break reads */ }
  }
}

function _empty(): Store { return { version: STORE_VERSION, vaults: Object.create(null) }; }

function _parse(raw: string, file: string, stamp: string, report: typeof _report = _report): Store {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch (_) {
    report(file, stamp, `${file} is not valid JSON; every security setting uses its protected default`);
    return _empty();
  }
  if (!parsed || typeof parsed !== "object" || !parsed.vaults || typeof parsed.vaults !== "object" || Array.isArray(parsed.vaults)) {
    report(file, stamp, `${file} has an unexpected shape; every security setting uses its protected default`);
    return _empty();
  }
  const store = _empty();
  for (const [vk, vault] of Object.entries(parsed.vaults as Record<string, any>)) {
    if (!_validName(vk) || !vault || typeof vault !== "object" || !vault.hosts || typeof vault.hosts !== "object") continue;
    for (const [hostId, entry] of Object.entries(vault.hosts as Record<string, any>)) {
      if (!_validName(hostId) || !entry || typeof entry !== "object") continue;
      const values: SecurityValues = {};
      const rawValues = entry.values && typeof entry.values === "object" && !Array.isArray(entry.values) ? entry.values : {};
      for (const [k, v] of Object.entries(rawValues)) {
        const ok = validateSecurityValue(k, v);
        if (ok.ok) values[k as WeakeningKey] = ok.value;
        else report(file, stamp, `${file}: dropped ${JSON.stringify(k)} (${ok.reason}); it uses its protected default`);
      }
      const dismissed: Record<string, string> = {};
      const rawDismissed = entry.dismissed && typeof entry.dismissed === "object" ? entry.dismissed : {};
      for (const [k, h] of Object.entries(rawDismissed)) {
        if ((isWeakeningKey(k) || isExecutableKey(k)) && typeof h === "string" && HASH_RE.test(h)) dismissed[k] = h;
      }
      // Paths are only shape-checked here; resolveCliPath re-validates the
      // file itself on every use (it can change after it was confirmed).
      const paths: Partial<Record<ExecutableKey, string>> = {};
      const rawPaths = entry.paths && typeof entry.paths === "object" && !Array.isArray(entry.paths) ? entry.paths : {};
      for (const [k, v] of Object.entries(rawPaths)) {
        if (isExecutableKey(k) && typeof v === "string" && v && _isAbsoluteAnywhere(v)) paths[k] = v;
        else report(file, stamp, `${file}: dropped CLI path ${JSON.stringify(k)}; it uses the detected binary`);
      }
      if (!store.vaults[vk]) store.vaults[vk] = { hosts: Object.create(null) };
      store.vaults[vk].hosts[hostId] = { values, setAt: typeof entry.setAt === "string" ? entry.setAt : "", dismissed, paths };
    }
  }
  return store;
}

let _cache: { file: string; stamp: string; store: Store } | null = null;

function _stampOf(st: import("fs").Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

/** Read the store. Cached on (inode, size, mtime): one `stat` per lookup. */
function _load(file: string, fresh = false): Store {
  let st: import("fs").Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      _report(file, "stat", `couldn't read ${file}; every security setting uses its protected default: ${(e as Error).message}`);
    }
    _cache = null;
    return _empty();
  }
  const stamp = _stampOf(st);
  if (!fresh && _cache && _cache.file === file && _cache.stamp === stamp) return _cache.store;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    _report(file, stamp, `couldn't read ${file}; every security setting uses its protected default: ${(e as Error).message}`);
    return _empty();
  }
  const store = _parse(raw, file, stamp);
  _cache = { file, stamp, store };
  return store;
}

// ── the legit-write ledger (issue #30) ─────────────────────────────────

/**
 * Every content this store's writer puts on disk, by sha256 — the turn-end
 * tamper check's way to tell Gryphon's own writes from an agent's. It lives
 * on the renderer process (`process`), so every bundled copy of @gryphon/protect in one
 * Obsidian window (an embedder's and a standalone Gryphon's) shares it; an
 * agent subprocess can't reach it. Bounded: old entries fall off.
 */
const LEDGER_KEY = Symbol.for("gryphon.securityStoreWrites");
const LEDGER_MAX = 64;
// `priorRaw` is the file content this write was based on (null: no file).
// If it isn't the content Gryphon last knew, something else wrote in
// between — and this write carried that change forward, so the tamper
// check must still judge it.
type LedgerEntry = { seq: number; sha256: string; raw: string; priorRaw: string | null };

function _ledger(): { seq: number; entries: LedgerEntry[] } {
  // `process` is one object per process — the Obsidian renderer, or headless
  // Node — shared by every module copy loaded in it, and out of reach of an
  // agent subprocess. (window/globalThis would also do in the renderer, but
  // not headless, and the plugin lint rules steer away from both.)
  const g = process as any;
  if (!g[LEDGER_KEY] || !Array.isArray(g[LEDGER_KEY].entries)) {
    Object.defineProperty(g, LEDGER_KEY, { value: { seq: 0, entries: [] }, configurable: true, enumerable: false, writable: true });
  }
  return g[LEDGER_KEY];
}

function _recordWrite(raw: string, priorRaw: string | null) {
  const l = _ledger();
  l.seq += 1;
  l.entries.push({ seq: l.seq, sha256: _sha256(raw), raw, priorRaw });
  if (l.entries.length > LEDGER_MAX) l.entries.splice(0, l.entries.length - LEDGER_MAX);
}

function _sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Atomic write: 0700 dir, 0600 temp file in the same dir, rename over. */
function _save(store: Store, file: string, priorRaw: string | null = null) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { try { fs.chmodSync(dir, 0o700); } catch (_) {} }
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const raw = JSON.stringify(store, null, 2) + "\n";
  // Ledgered BEFORE the rename: a turn-end check racing this write must
  // never see Gryphon's own content as unknown.
  _recordWrite(raw, priorRaw);
  fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  _cache = null;
}

function _entry(store: Store, scope: SecurityScope): HostEntry | null {
  const vault = Object.prototype.hasOwnProperty.call(store.vaults, scope.vaultKey) ? store.vaults[scope.vaultKey] : null;
  return vault && Object.prototype.hasOwnProperty.call(vault.hosts, scope.hostId) ? vault.hosts[scope.hostId] : null;
}

function _requireScope(scope: SecurityScope | null | undefined): SecurityScope {
  if (!scope || !_validName(scope.vaultKey) || !_validName(scope.hostId)) {
    throw new SecurityScopeUnavailableError(!scope ? "app" : !_validName(scope.vaultKey) ? "basePath" : "hostId");
  }
  return scope;
}

/** Re-read right before writing; change only this scope's entry. */
function _update(scope: SecurityScope, file: string, fn: (entry: HostEntry) => void) {
  const priorRaw = _readRaw(file);
  const store = priorRaw === null ? _empty() : _parse(priorRaw, file, "update");
  if (!store.vaults[scope.vaultKey]) store.vaults[scope.vaultKey] = { hosts: Object.create(null) };
  const hosts = store.vaults[scope.vaultKey].hosts;
  if (!hosts[scope.hostId]) hosts[scope.hostId] = { values: {}, setAt: "", dismissed: {}, paths: {} };
  fn(hosts[scope.hostId]);
  _save(store, file, priorRaw);
}

// ── public API ─────────────────────────────────────────────────────────

/** This scope's confirmed values (validated). */
function readMachineSecuritySettings(scope: SecurityScope, opts: { file?: string } = {}): SecurityValues {
  const entry = _entry(_load(opts.file || securitySettingsFilePath()), _requireScope(scope));
  return entry ? { ...entry.values } : {};
}

/**
 * Store a value for this scope. Call ONLY from an explicit user gesture on
 * this machine. Validates; throws on an unknown key or an invalid value.
 * Writes in both directions: turning protection back on is stored too, so
 * a stale weaker value can't keep winning.
 */
function setMachineSecuritySetting(scope: SecurityScope, key: WeakeningKey, value: unknown, opts: { file?: string; now?: Date } = {}): void {
  _requireScope(scope);
  const v = validateSecurityValue(key, value);
  if (!v.ok) throw new Error(`security-settings: ${v.reason}`);
  _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
    entry.values[key] = v.value;
    entry.setAt = (opts.now || new Date()).toISOString();
    delete entry.dismissed[key];
  });
}

/** "Keep protections on": stay quiet until data.json brings a different value. */
function dismissVaultSecuritySuggestion(scope: SecurityScope, key: WeakeningKey | ExecutableKey, value: unknown, opts: { file?: string } = {}): void {
  _requireScope(scope);
  if (isExecutableKey(key)) {
    const configured = _configuredPath(value);
    if (!configured) throw new Error(`security-settings: ${key} must be a path`);
    _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
      entry.dismissed[key] = hashValue(configured);
    });
    return;
  }
  if (!isWeakeningKey(key)) throw new Error(`security-settings: unknown key ${JSON.stringify(key)}`);
  // Hash the normalized value: that's what effectiveSecuritySettings compares.
  const v = validateSecurityValue(key, value);
  if (!v.ok) throw new Error(`security-settings: ${v.reason}`);
  _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
    entry.dismissed[key] = hashValue(v.value);
  });
}

/**
 * Validate a consumer's `securityOverrides`. Unknown keys and invalid values
 * are logged and ignored (they resolve as if absent).
 */
function sanitizeSecurityOverrides(overrides: unknown, label = "securityOverrides"): SecurityValues {
  const out: SecurityValues = {};
  if (overrides === undefined || overrides === null) return out;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    console.error(`[gryphon] ${label} must be an object; ignored`);
    return out;
  }
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    // Issue #30: `paths` carries code-set CLI binaries — see sanitizeCliPathOverrides.
    if (k === "paths") continue;
    const ok = validateSecurityValue(k, v);
    if (ok.ok) out[k as WeakeningKey] = ok.value;
    else console.error(`[gryphon] ${label}: ignored ${JSON.stringify(k)} (${ok.reason})`);
  }
  return out;
}

function _sameValue(a: unknown, b: unknown): boolean {
  return mcpApprovals.canonicalJSON(a) === mcpApprovals.canonicalJSON(b);
}

function _freezeDeep<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as any)) _freezeDeep(v);
    Object.freeze(o);
  }
  return o;
}

function _stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * The frozen snapshot every enforcement site reads: the nine weakening
 * keys, plus the strengthen-only inputs copied from `settings`
 * (`autoDenyProtected` and the custom pattern lists), plus metadata:
 *   source       — where each weakening key's value came from
 *   unconfirmed  — weakening data.json values not confirmed on this machine
 *   scopeAvailable — false when no store scope exists (reads failed closed)
 */
function effectiveSecuritySettings(
  settings: any, scope: SecurityScope | null, overrides?: SecurityValues & { paths?: unknown },
  opts: { file?: string; detect?: (kind: string) => string | null } = {},
) {
  const raw = settings && typeof settings === "object" ? settings : {};
  const ov = sanitizeSecurityOverrides(overrides);
  let machine: SecurityValues = {};
  let dismissed: Record<string, string> = {};
  let machinePaths: Partial<Record<ExecutableKey, string>> = {};
  if (scope) {
    const entry = _entry(_load(opts.file || securitySettingsFilePath()), scope);
    if (entry) { machine = entry.values; dismissed = entry.dismissed; machinePaths = entry.paths || {}; }
  }
  const out: Record<string, any> = {};
  const source: Record<string, Source> = {};
  const unconfirmed: WeakeningKey[] = [];
  for (const key of WEAKENING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ov, key)) {
      out[key] = ov[key]; source[key] = "override";
    } else if (Object.prototype.hasOwnProperty.call(machine, key)) {
      out[key] = machine[key]; source[key] = "machine";
    } else {
      out[key] = DEFAULTS[key]; source[key] = "default";
    }
    out[key] = Array.isArray(out[key]) ? [...out[key]] : out[key];
    if (!scope || source[key] === "override") continue;
    // The data.json comparison: a suggestion, never an input.
    const fromFile = validateSecurityValue(key, raw[key]);
    if (!fromFile.ok || !isWeakening(key, fromFile.value)) continue;
    if (_sameValue(fromFile.value, out[key])) continue;
    if (dismissed[key] === hashValue(fromFile.value)) continue;
    unconfirmed.push(key);
  }
  out.autoDenyProtected = raw.autoDenyProtected === true;
  out.protectedPathsCustom = _stringList(raw.protectedPathsCustom);
  out.protectedCommandsCustom = _stringList(raw.protectedCommandsCustom);
  out.source = source;
  out.unconfirmed = unconfirmed;
  out.scopeAvailable = !!scope;
  // Issue #30: this machine's confirmed CLI paths for the scope, and the
  // data.json paths that differ from what would run — suggestions for the
  // one-time confirm, never spawn inputs.
  out.paths = { ...machinePaths };
  out.unconfirmedPaths = scope
    ? _unconfirmedPaths(raw, machinePaths, dismissed, sanitizeCliPathOverrides(overrides && (overrides as any).paths), opts.detect)
    : [];
  return _freezeDeep(out);
}

function _unconfirmedPaths(
  raw: Record<string, unknown>, machinePaths: Partial<Record<ExecutableKey, string>>,
  dismissed: Record<string, string>, ovPaths: Partial<Record<ExecutableKey, string>>,
  detect?: (kind: string) => string | null,
): ExecutableKey[] {
  const out: ExecutableKey[] = [];
  for (const [kind, key] of Object.entries(CLI_PATH_KEY_BY_KIND)) {
    const fromFile = _configuredPath(raw[key]);   // cli-path-read-ok: the migration comparator
    if (!fromFile || ovPaths[key]) continue;
    if (machinePaths[key] === fromFile) continue;
    if (dismissed[key] === hashValue(fromFile)) continue;
    // Equal to what detection finds → nothing to confirm (most users).
    const detected = _detect(kind, detect);
    if (detected && _samePath(detected, fromFile)) continue;
    out.push(key);
  }
  return out;
}

/** Just the nine weakening values of a snapshot (for comparisons / logs). */
function securityValuesOf(sec: any): SecurityValues {
  const out: SecurityValues = {};
  for (const k of WEAKENING_KEYS) out[k] = sec ? sec[k] : undefined;
  return out;
}

let _warnedNoSnapshot = false;

/**
 * The security inputs for an enforcement call. `holder.security` (the
 * snapshot) wins. Without one, an explicit `holder.settings` — a config the
 * caller's code supplied — is used: that's the library contract for
 * headless callers.
 *
 * Issue #30 (G4): `holder.plugin.settings` is NOT an input. That object is
 * the host's data.json, which travels with the vault. A caller that passes
 * only `plugin` gets the protected defaults plus the strengthen-only keys
 * (autoDenyProtected, the custom pattern lists), frozen, and one warning
 * per process. Gryphon's own call sites always pass a snapshot.
 */
function securityInputsOf(holder: any): Record<string, any> {
  if (holder && holder.security && typeof holder.security === "object") return holder.security;
  if (holder && holder.settings && typeof holder.settings === "object") return holder.settings;
  const plugin = holder && holder.plugin;
  if (!plugin) return {};
  if (!_warnedNoSnapshot) {
    _warnedNoSnapshot = true;
    console.warn(
      "[gryphon/security-settings] a protection check got no security snapshot; using the protected " +
      "defaults (the host's settings file is never an enforcement input). Pass `security` " +
      "(effectiveSecuritySettings) or an explicit `settings` object.",
    );
  }
  const ps = plugin.settings && typeof plugin.settings === "object" ? plugin.settings : {};
  return _freezeDeep({
    ...DEFAULTS,
    protectedPathsDisabled: [],
    protectedCommandsDisabled: [],
    autoDenyProtected: ps.autoDenyProtected === true,
    protectedPathsCustom: _stringList(ps.protectedPathsCustom),
    protectedCommandsCustom: _stringList(ps.protectedCommandsCustom),
  });
}

// ── CLI binary paths (issue #30, G1) ──────────────────────────────────

type CliPathRejectReason = "relative" | "missing" | "not-a-file" | "not-executable" | "inside-vault" | "too-old";

/** Thrown by setMachineCliPath only; resolveCliPath never throws. */
class CliPathRejectedError extends Error {
  key: ExecutableKey;
  value: string;
  reason: CliPathRejectReason;
  constructor(key: ExecutableKey, value: string, reason: CliPathRejectReason) {
    super(`Gryphon can't use ${JSON.stringify(value)} for ${key}: ${CLI_PATH_REASON_TEXT[reason]}`);
    this.name = "CliPathRejectedError";
    this.key = key;
    this.value = value;
    this.reason = reason;
  }
}

const CLI_PATH_REASON_TEXT: Record<CliPathRejectReason, string> = {
  "relative": "use the full path (starting with / or a drive letter)",
  "missing": "no file exists there",
  "not-a-file": "that's a folder, not a program",
  "not-executable": "that file isn't executable",
  "inside-vault": "it's inside this vault, and files in a vault can change when the vault syncs",
  "too-old": "that version is too old",
};

const WIN_EXEC_RE = /\.(exe|cmd|bat|ps1)$/i;

function _isAbsoluteAnywhere(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** A configured path as stored: trimmed, `~` expanded. "" when unusable. */
function _configuredPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  if (/^~(?=$|[\\/])/.test(v)) return path.join(os.homedir(), v.slice(1));
  return v;
}

function _norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** `p` is `root` or inside it. Case-insensitive: a false positive refuses, never allows. */
function _inside(p: string, root: string): boolean {
  const a = _norm(p);
  const r = _norm(root);
  return !!r && (a === r || a.startsWith(r + "/"));
}

function _vaultRoots(vaultRoot: string | null | undefined): string[] {
  if (!vaultRoot) return [];
  const roots = [path.resolve(vaultRoot)];
  try { roots.push(fs.realpathSync(vaultRoot)); } catch (_) { /* gone */ }
  return roots;
}

function _samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  return _norm(real(a)) === _norm(real(b));
}

/**
 * Validate a configured CLI path. Returns the configured path and its
 * realpath (the thing to spawn), or why it can't be used. The configured
 * path AND its realpath must both be outside the vault: an in-vault symlink
 * to an outside binary could be re-pointed by sync.
 */
function validateCliPath(value: unknown, vaultRoot: string | null | undefined, platform: string = process.platform):
  { ok: true; configured: string; real: string } | { ok: false; reason: CliPathRejectReason } {
  const configured = _configuredPath(value);
  if (!configured || !_isAbsoluteAnywhere(configured)) return { ok: false, reason: "relative" };
  const roots = _vaultRoots(vaultRoot);
  if (roots.some((r) => _inside(configured, r))) return { ok: false, reason: "inside-vault" };
  let real: string;
  try { real = fs.realpathSync(configured); } catch (_) { return { ok: false, reason: "missing" }; }
  if (roots.some((r) => _inside(real, r))) return { ok: false, reason: "inside-vault" };
  let st: import("fs").Stats;
  try { st = fs.statSync(real); } catch (_) { return { ok: false, reason: "missing" }; }
  if (!st.isFile()) return { ok: false, reason: "not-a-file" };
  if (platform === "win32") {
    if (!WIN_EXEC_RE.test(real)) return { ok: false, reason: "not-executable" };
  } else {
    try { fs.accessSync(real, fs.constants.X_OK); } catch (_) { return { ok: false, reason: "not-executable" }; }
  }
  return { ok: true, configured, real };
}

/**
 * Store a CLI path for this scope, from a user gesture on this machine
 * (Settings, the one-time confirm). Stores the CONFIGURED path (a symlink
 * stays a symlink, so a CLI's self-update doesn't strand it); validates on
 * write and again on every resolve. `null` / "" clears it. Throws
 * CliPathRejectedError with the reason when the path can't be used.
 */
function setMachineCliPath(scope: SecurityScope, key: ExecutableKey, value: string | null, opts: { file?: string } = {}): void {
  _requireScope(scope);
  if (!isExecutableKey(key)) throw new Error(`security-settings: unknown CLI path key ${JSON.stringify(key)}`);
  const cleared = value === null || value === undefined || (typeof value === "string" && !value.trim());
  let configured = "";
  if (!cleared) {
    const v = validateCliPath(value, scope.vaultKey);
    if (!v.ok) throw new CliPathRejectedError(key, String(value), v.reason);
    configured = v.configured;
  }
  _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
    if (!entry.paths) entry.paths = {};
    if (cleared) delete entry.paths[key];
    else entry.paths[key] = configured;
    entry.setAt = new Date().toISOString();
    delete entry.dismissed[key];
  });
}

/** Validate an embedder's code-set `securityOverrides.paths`. */
function sanitizeCliPathOverrides(paths: unknown): Partial<Record<ExecutableKey, string>> {
  const out: Partial<Record<ExecutableKey, string>> = {};
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return out;
  for (const [k, v] of Object.entries(paths as Record<string, unknown>)) {
    const p = _configuredPath(v);
    if (isExecutableKey(k) && p) out[k] = p;
    else console.error(`[gryphon] securityOverrides.paths: ignored ${JSON.stringify(k)}`);
  }
  return out;
}

/**
 * Detection is provider-runtime's find*Binary — the exact functions every
 * caller used before, so an embedder's fallback can't diverge from the chat
 * view's. Looked up through the module object on each call so a patched
 * finder (tests) applies. A caller may inject its own `detect`.
 */
const FINDER_BY_KIND: Record<string, string> = {
  "claude-code": "findClaudeBinary",
  "codex-cli": "findCodexBinary",
  "gemini-cli": "findGeminiBinary",
  "antigravity-cli": "findAntigravityBinary",
};
function _runtimeUtils() { return require("../../provider-runtime/dist/utils"); }
function _detect(kind: string, detect?: (kind: string) => string | null): string | null {
  try {
    if (typeof detect === "function") return detect(kind) || null;
    const fn = _runtimeUtils()[FINDER_BY_KIND[kind]];
    return typeof fn === "function" ? fn() || null : null;
  } catch (e) {
    console.warn(`[gryphon/security-settings] detecting ${kind} failed: ${(e as Error).message}`);
    return null;
  }
}

/** The version floor check — runs ONLY on an already-validated realpath. */
function _versionOf(kind: string, real: string): { version: number[] | null; tooOld: boolean } {
  try {
    const u = _runtimeUtils();
    const label = ({ "claude-code": "claude", "codex-cli": "codex", "gemini-cli": "gemini", "antigravity-cli": "agy" } as Record<string, string>)[kind];
    const v = u.probeVersion(real, undefined, u._versionSignatureFor(label));
    // The runtime's floors are permissive today ("0.0.0"); a too-old
    // verdict comes from resolveCliBinary's typed failure.
    if (!v) return { version: null, tooOld: false };
    const r = u.resolveCliBinary(kind, real);
    const tooOld = !!(r && !r.ok && r.error === "too-old");
    return { version: v, tooOld };
  } catch (_) {
    return { version: null, tooOld: false };
  }
}

const _reportedRejections = new Set<string>();
let _warnedNoHostId = false;

type ResolvedCliPath = {
  path: string | null;
  source: "override" | "machine" | "detected" | null;
  version: string | null;
  rejected?: { key: ExecutableKey; value: string; reason: CliPathRejectReason };
  unavailable?: "not-found" | "too-old";
};

/**
 * Issue #30: the ONE resolver every CLI spawn and probe goes through.
 * Synchronous; never throws. Order:
 *   1. `overrides.paths[key]` — set by the embedder's code;
 *   2. this machine's store for (vault, hostId) — a user gesture here;
 *   3. detection (find*Binary).
 * Each candidate is validated (absolute; realpath is an executable regular
 * file; neither inside the vault) BEFORE its `--version` is probed, so an
 * unvalidated binary is never executed. `path` is the realpath computed in
 * this call — spawn exactly that. A rejected candidate comes back in
 * `rejected` (logged once) and resolution falls through. data.json is never
 * consulted. No hostId (an embedder that hasn't pinned one) → the store is
 * skipped.
 */
function resolveCliPath(
  kind: string,
  ctx: { app?: any; hostPlugin?: any; hostId?: string; overrides?: { paths?: unknown } | null; detect?: (kind: string) => string | null } = {},
): ResolvedCliPath {
  const key = CLI_PATH_KEY_BY_KIND[kind];
  if (!key) return { path: null, source: null, version: null, unavailable: "not-found" };
  const described = describeSecurityScope({ app: ctx.app, hostPlugin: ctx.hostPlugin, hostId: ctx.hostId });
  const scope = described.scope;
  const vaultRoot = scope ? scope.vaultKey : _basePathOf(ctx.app || (ctx.hostPlugin && ctx.hostPlugin.app));
  let rejected: ResolvedCliPath["rejected"];
  let tooOldSeen = false;

  const reject = (value: string, reason: CliPathRejectReason) => {
    if (!rejected) rejected = { key, value, reason };
    const tag = `${key}\u0000${value}\u0000${reason}`;
    if (!_reportedRejections.has(tag)) {
      _reportedRejections.add(tag);
      console.warn(`[gryphon] not using ${value} for ${key}: ${CLI_PATH_REASON_TEXT[reason]}. Falling back.`);
    }
  };
  const tryCandidate = (value: string, source: "override" | "machine" | "detected"): ResolvedCliPath | null => {
    const v = validateCliPath(value, vaultRoot);
    if (!v.ok) { reject(value, v.reason); return null; }
    const ver = _versionOf(kind, v.real);
    if (ver.tooOld) { tooOldSeen = true; reject(value, "too-old"); return null; }
    const out: ResolvedCliPath = { path: v.real, source, version: ver.version ? ver.version.join(".") : null };
    if (rejected) out.rejected = rejected;
    return out;
  };

  const ov = sanitizeCliPathOverrides(ctx.overrides && ctx.overrides.paths);
  if (ov[key]) {
    const r = tryCandidate(ov[key] as string, "override");
    if (r) return r;
  }
  if (scope) {
    let stored: string | undefined;
    try {
      const entry = _entry(_load(securitySettingsFilePath()), scope);
      stored = entry && entry.paths ? entry.paths[key] : undefined;
    } catch (_) { stored = undefined; }
    if (stored) {
      const r = tryCandidate(stored, "machine");
      if (r) return r;
    }
  } else if (described.missing === "hostId" && !_warnedNoHostId) {
    _warnedNoHostId = true;
    console.warn("[gryphon] no securityHostId: CLI paths confirmed on this machine are not used; set securityHostId in the view options.");
  }
  const detected = _detect(kind, ctx.detect);
  if (detected) {
    const r = tryCandidate(detected, "detected");
    if (r) return r;
  }
  const out: ResolvedCliPath = { path: null, source: null, version: null, unavailable: tooOldSeen ? "too-old" : "not-found" };
  if (rejected) out.rejected = rejected;
  return out;
}

function _basePathOf(app: any): string | null {
  try {
    const a = app && app.vault && app.vault.adapter;
    const bp = a && typeof a.getBasePath === "function" ? a.getBasePath() : a && a.basePath;
    return typeof bp === "string" && bp ? bp : null;
  } catch (_) { return null; }
}

// ── turn-window tamper check (issue #30, G2) ──────────────────────────

type StoreSnapshot = { file: string; raw: string | null; seq: number };

function _readRaw(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return null; }
}

/** Turn start: remember the store's content and the ledger position. */
function snapshotSecurityStore(opts: { file?: string } = {}): StoreSnapshot {
  const file = opts.file || securitySettingsFilePath();
  return { file, raw: _readRaw(file), seq: _ledger().seq };
}

const _quiet = () => { /* the tamper check reports through its own result */ };

const PERM_STRENGTH: Record<string, number> = { plan: 3, default: 2, acceptEdits: 1, bypassPermissions: 0 };

/** a is looser (removes protection) than b. Both are validated values. */
function _looser(key: WeakeningKey, a: any, b: any): boolean {
  switch (key) {
    case "protectedMode":
    case "protectedPathsEnabled":
    case "protectedCommandsEnabled":
    case "blockPackageInstall":
      return a === false && b !== false;
    case "claudeCodeInheritUserConfig":
      return a === true && b !== true;
    case "obsidianRestApiPolicy":
      return a === "allowed" && b !== "allowed";
    case "permissionMode":
      return (PERM_STRENGTH[a] ?? 0) < (PERM_STRENGTH[b] ?? 0);
    case "protectedPathsDisabled":
    case "protectedCommandsDisabled":
      return (a as string[]).some((p) => !(b as string[]).includes(p));
  }
}

type Reverted = { vaultKey: string; hostId: string; key: string };
type Weakened = { vaultKey: string; hostId: string; field: "values" | "paths" | "dismissed"; key: string; baseHas: boolean; baseVal: any; candVal: any };

function _emptyEntry(): HostEntry { return { values: {}, setAt: "", dismissed: {}, paths: {} }; }

/** Every entry, for any vault and host, that is weaker in `cand` than in `base`. */
function _weakenings(cand: Store, base: Store): Weakened[] {
  const out: Weakened[] = [];
  for (const [vk, vault] of Object.entries(cand.vaults)) {
    for (const [hostId, entry] of Object.entries(vault.hosts)) {
      const b = _entry(base, { vaultKey: vk, hostId }) || _emptyEntry();
      for (const key of WEAKENING_KEYS) {
        const av = Object.prototype.hasOwnProperty.call(entry.values, key) ? entry.values[key] : DEFAULTS[key];
        const bHas = Object.prototype.hasOwnProperty.call(b.values, key);
        const bv = bHas ? b.values[key] : DEFAULTS[key];
        if (_looser(key, av, bv)) out.push({ vaultKey: vk, hostId, field: "values", key, baseHas: bHas, baseVal: b.values[key], candVal: entry.values[key] });
      }
      for (const field of ["paths", "dismissed"] as const) {
        const cur: Record<string, string> = (entry as any)[field] || {};
        const was: Record<string, string> = (b as any)[field] || {};
        for (const key of Object.keys(cur)) {
          if (was[key] === cur[key]) continue;
          out.push({ vaultKey: vk, hostId, field, key, baseHas: !!was[key], baseVal: was[key], candVal: cur[key] });
        }
      }
    }
  }
  return out;
}

/**
 * Turn end. Walk from the turn-start content through every write Gryphon
 * made during this turn (the ledger, seq > snapshot) to what's on disk now.
 * Wherever the content Gryphon found wasn't the content it last knew —
 * between two of its writes, or after the last one — something else wrote,
 * and every entry that change made WEAKER (a weakening key loosened, a CLI
 * path added or changed, a dismissal added or changed), for any vault and
 * host, is put back, unless a later Gryphon write set that entry itself.
 * Only writes from THIS turn count as Gryphon's, so restoring an older
 * Gryphon-written file is judged like any other foreign write; and a write
 * Gryphon based on tampered content doesn't launder the tampering.
 * Strengthening changes, and a missing or unreadable file (it already reads
 * as the defaults), are left alone. The revert is ledgered like any write.
 */
function checkSecurityStoreTamper(before: StoreSnapshot): { changed: boolean; reverted: Reverted[] } {
  const file = before.file;
  const now = _readRaw(file);
  if (now === before.raw) return { changed: false, reverted: [] };
  const parse = (raw: string | null) => (raw === null ? _empty() : _parse(raw, file, "tamper", _quiet));
  const parseable = (raw: string | null) => { if (raw === null) return true; try { JSON.parse(raw); return true; } catch (_) { return false; } };

  // Foreign changes: each (found, knownBefore) pair where they differ,
  // tagged with the index of the first Gryphon write that came after it.
  const mine = _ledger().entries.filter((e) => e.seq > before.seq);
  const foreign: Array<Weakened & { stage: number }> = [];
  let known = before.raw;
  mine.forEach((e, i) => {
    if (e.priorRaw !== known && parseable(e.priorRaw)) {
      for (const w of _weakenings(parse(e.priorRaw), parse(known))) foreign.push({ ...w, stage: i });
    }
    known = e.raw;
  });
  if (now === null || !parseable(now)) return { changed: true, reverted: [] };
  if (now !== known) for (const w of _weakenings(parse(now), parse(known))) foreign.push({ ...w, stage: mine.length });
  if (!foreign.length) return { changed: true, reverted: [] };

  // What each of Gryphon's own writes changed, judged against the content
  // it was based on — never against the result, which may carry a foreign
  // change forward (a Settings list write re-saves the whole list).
  const ownChange = mine.map((e) => ({ prior: parse(e.priorRaw), next: parse(e.raw) }));
  const field = (st: Store, w: Weakened): any => {
    const en = _entry(st, { vaultKey: w.vaultKey, hostId: w.hostId });
    return en ? ((en as any)[w.field] || {})[w.key] : undefined;
  };
  const same = (a: any, b: any) => mcpApprovals.canonicalJSON(a) === mcpApprovals.canonicalJSON(b);

  // Resolve each (vault, host, field, key) ONCE, back to a trusted value:
  // the latest value Gryphon itself set (its own change, judged against the
  // content it read), else the turn-start value — never a per-stage base,
  // which may be content a foreign write carried forward.
  const start0 = parse(before.raw);
  const groups = new Map<string, Array<Weakened & { stage: number }>>();
  for (const w of foreign) {
    const tag = `${w.vaultKey}\u0000${w.hostId}\u0000${w.field}\u0000${w.key}`;
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(w);
  }
  const after = parse(now);
  const reverted: Reverted[] = [];
  for (const ws of groups.values()) {
    const w0 = ws[0];
    const entry = _entry(after, { vaultKey: w0.vaultKey, hostId: w0.hostId });
    if (!entry) continue;
    const bag: Record<string, any> = (entry as any)[w0.field] || ((entry as any)[w0.field] = {});
    const startEntry = _entry(start0, { vaultKey: w0.vaultKey, hostId: w0.hostId });
    const startBag: Record<string, any> = startEntry ? (startEntry as any)[w0.field] || {} : {};
    const isList = w0.field === "values" && Array.isArray(DEFAULTS[w0.key as WeakeningKey]);
    let changed = false;
    if (isList) {
      // Remove every item a foreign write added. Gryphon only gets credit
      // for an item no foreign content ever held (fails toward protection).
      const foreignHeld = new Set<string>();
      const foreignAdded = new Set<string>();
      for (const w of ws) {
        const base: string[] = Array.isArray(w.baseVal) ? w.baseVal : [];
        for (const x of (Array.isArray(w.candVal) ? w.candVal : []) as string[]) {
          foreignHeld.add(x);
          if (!base.includes(x)) foreignAdded.add(x);
        }
      }
      const credited = new Set<string>();
      for (const c of ownChange) {
        const p0: string[] = field(c.prior, w0) || [];
        for (const x of (field(c.next, w0) || []) as string[]) if (!p0.includes(x) && !foreignHeld.has(x)) credited.add(x);
      }
      const cur: string[] = Array.isArray(bag[w0.key]) ? bag[w0.key] : [];
      const kept = cur.filter((x) => !foreignAdded.has(x) || credited.has(x));
      if (kept.length !== cur.length) {
        changed = true;
        if (kept.length || Object.prototype.hasOwnProperty.call(startBag, w0.key)) bag[w0.key] = kept; else delete bag[w0.key];
      }
    } else {
      // The latest Gryphon write that set this key, if any.
      let lastSet = -1;
      ownChange.forEach((c, i) => { if (!same(field(c.prior, w0), field(c.next, w0))) lastSet = i; });
      // Foreign stage s sits just before Gryphon write s; only a foreign
      // change AFTER Gryphon's own setting overrides it.
      if (!ws.some((w) => w.stage > lastSet)) continue;
      const targetHas = lastSet >= 0
        ? field(ownChange[lastSet].next, w0) !== undefined
        : Object.prototype.hasOwnProperty.call(startBag, w0.key);
      const target = lastSet >= 0 ? field(ownChange[lastSet].next, w0) : startBag[w0.key];
      if (same(bag[w0.key], targetHas ? target : undefined)) continue;
      if (targetHas) bag[w0.key] = target; else delete bag[w0.key];
      changed = true;
    }
    if (changed) reverted.push({ vaultKey: w0.vaultKey, hostId: w0.hostId, key: w0.field === "values" ? w0.key : `${w0.field}.${w0.key}` });
  }
  if (reverted.length) {
    _save(after, file, now);
    console.warn(
      "[gryphon/security-settings] undid changes to Gryphon's security settings made outside Gryphon during a reply: " +
      reverted.map((r) => `${r.hostId}:${r.key}`).join(", "),
    );
  }
  return { changed: true, reverted };
}

module.exports = {
  WEAKENING_KEYS,
  EXECUTABLE_KEYS,
  CLI_PATH_KEY_BY_KIND,
  isExecutableKey,
  CliPathRejectedError,
  validateCliPath,
  setMachineCliPath,
  sanitizeCliPathOverrides,
  resolveCliPath,
  snapshotSecurityStore,
  checkSecurityStoreTamper,
  SECURITY_DEFAULTS: DEFAULTS,
  isWeakeningKey,
  isWeakening,
  validateSecurityValue,
  hashValue,
  securitySettingsFilePath,
  SecurityScopeUnavailableError,
  describeSecurityScope,
  resolveSecurityScope,
  scopeKey,
  onSecurityStoreError,
  readMachineSecuritySettings,
  setMachineSecuritySetting,
  dismissVaultSecuritySuggestion,
  sanitizeSecurityOverrides,
  effectiveSecuritySettings,
  securityValuesOf,
  securityInputsOf,
};
