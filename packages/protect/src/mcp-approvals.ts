// TypeScript module marker.

/**
 * Vault MCP server approvals (issue #25, Design rev 2).
 *
 * An entry in a vault's `.mcp.json` is a command line, and Gryphon's chat
 * runs with the vault as its cwd. Vaults get shared, synced and cloned, so
 * their contents can't approve anything. Gryphon runs a vault-defined MCP
 * server only when an approval stored HERE — in the user profile, outside
 * every vault — matches the server's exact spec.
 *
 * That rules out Gryphon's own `data.json` too: it lives at
 * `<vault>/<config dir>/plugins/gryphon/` and travels with the vault.
 *
 *   macOS / Linux: $XDG_CONFIG_HOME/gryphon/mcp-approvals.json (~/.config fallback)
 *   Windows:       %APPDATA%\gryphon\mcp-approvals.json
 *
 *   { "version": 1,
 *     "vaults": { "<realpath(vault)>": { "<name>": { "sha256": "<hex>", "approvedAt": "ISO" } } } }
 *
 * Only the hash is stored — a spec's `env` / `headers` may hold secrets.
 * The hash covers the WHOLE raw entry (keys sorted recursively, before any
 * `${VAR}` expansion), so editing any field needs a fresh approval.
 *
 * Guaranteed property: no unapproved vault server starts automatically at
 * spawn. Keeping the chat from approving its own servers is BEST-EFFORT:
 * the attack detector gates every file tool whose path lands in this
 * directory (`isApprovalsStorePath`), but its shell check
 * (`mentionsApprovalsStore`) is lexical — globs, quoting tricks, a staged
 * `cd`, or `python -c` assembling the path get past it. A model with Bash
 * can already run commands directly, so that isn't an escalation past
 * what Bash grants; a stronger barrier is tracked separately.
 *
 * Pure apart from file I/O, so the provider (reads on every spawn) and the
 * plugin (approve / revoke from the modal and settings) share it.
 */

const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const path = require("path") as typeof import("path");
const crypto = require("crypto") as typeof import("crypto");
const { TOOL_ALIASES, patchTargetsInfo, shellCdDirs } = require("./tool-aliases");
const { fileIdCached, isWithinIds } = require("./path-identity");
const { readRegularFile, clearNonFile } = require("./safe-read");

const STORE_VERSION = 1;
const FILE_NAME = "mcp-approvals.json";
const HASH_RE = /^[0-9a-f]{64}$/;
/**
 * Names a plain-object map can't hold as a key: assigning `obj["__proto__"]`
 * swaps the prototype instead of storing an entry, so an approval would be
 * silently lost. Such servers stay unapproved and the modal says why.
 */
const RESERVED_NAMES = new Set(["__proto__"]);

function isApprovableName(name: unknown): boolean {
  return typeof name === "string" && name.length > 0 && !RESERVED_NAMES.has(name);
}

interface ApprovalEntry { sha256: string; approvedAt: string }
interface ApprovalStore { version: number; vaults: Record<string, Record<string, ApprovalEntry>> }
interface LocateOpts { platform?: string; env?: Record<string, string | undefined>; homedir?: string }

// Unicode property classes, not a hand list (issue #28): controls (Cc),
// format chars (Cf: bidi controls, soft hyphen, U+061C, tags, U+FFF9–FFFB),
// line / paragraph separators, and default-ignorables (U+034F, hangul
// fillers, U+180E, variation selectors). U+2800 is So, so it's named.
const UNSAFE_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * A vault-supplied string made safe to show: control, format, separator and
 * invisible (default-ignorable) characters become visible `\u{XXXX}`
 * escapes, so a server name or value can't reorder, hide or pad text in a
 * Notice or the review modal (an RLO in a name, a newline faking a second
 * line, blank-looking filler).
 */
function _isUnsafeChar(ch: string): boolean {
  return UNSAFE_CHAR_RE.test(ch);
}

function displaySafe(v: unknown): string {
  let out = "";
  for (const ch of String(v)) {
    const code = ch.codePointAt(0)!;
    out += _isUnsafeChar(ch) ? `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}` : ch;
  }
  return out;
}

function approvalsDir(opts: LocateOpts = {}): string {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.homedir || os.homedir();
  if (platform === "win32") {
    const base = env.APPDATA && path.win32.isAbsolute(env.APPDATA)
      ? env.APPDATA
      : path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(base, "gryphon");
  }
  // A relative XDG_CONFIG_HOME is invalid per the XDG spec — ignore it.
  const xdg = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null;
  return path.join(xdg || path.join(home, ".config"), "gryphon");
}

function approvalsFilePath(opts: LocateOpts = {}): string {
  const dir = approvalsDir(opts);
  return (opts.platform || process.platform) === "win32" ? path.win32.join(dir, FILE_NAME) : path.join(dir, FILE_NAME);
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  // undefined has no JSON form; treat it like a missing key's absence.
  return value === undefined ? "null" : JSON.stringify(value);
}

function hashSpec(spec: unknown): string {
  return crypto.createHash("sha256").update(canonicalJSON(spec)).digest("hex");
}

/**
 * The store key for a vault: its realpath, so a symlinked path to the same
 * vault shares approvals while a clone or a moved copy needs its own.
 */
function vaultKey(cwd: string): string {
  try { return fs.realpathSync(cwd); } catch (_) { return path.resolve(cwd); }
}

function emptyStore(): ApprovalStore {
  // Prototype-free maps: a vault key comes from the file (review: a
  // "__proto__" key polluted Object.prototype for every plugin).
  return { version: STORE_VERSION, vaults: Object.create(null) };
}

/** A vault key as Gryphon writes it: an absolute path, never a reserved name. */
function _validVaultKey(vk: string): boolean {
  return typeof vk === "string" && vk.length > 0 && vk.length <= 4096 &&
    vk !== "__proto__" && vk !== "constructor" && vk !== "prototype";
}

/**
 * Read the store. Missing → empty. Unreadable / corrupt → empty AND a log
 * line: fail closed (nothing approved) rather than guess.
 */
function load(file: string = approvalsFilePath()): ApprovalStore {
  // Issue #32 review: judge exactly the content that was parsed.
  // Re-review: a record this window knows but that's gone from disk is put back.
  const known = _ownWrite().accepted.get(file);
  if (known !== undefined && _readTrustedCopy(file) === null) _writeTrusted(file, known);
  const read: { raw: string | null; absent?: boolean } = { raw: null };
  const store = _loadUnverified(file, read);
  if (read.raw === null) {
    // Re-review: only a file that truly doesn't exist means "nothing
    // approved"; an unreadable one may hold the user's approvals.
    if (!read.absent) return store;
    // Post-push review F2 (sibling): no approvals file and no record (a user
    // who never approved a server) is a known state — nothing approved. Record
    // it, so an approvals file that appears later isn't adopted.
    const mem = _ownWrite().accepted.get(file);
    const copy = _readTrustedCopy(file);
    if (mem === undefined && copy === null) _initEmptyRecord(file, JSON.stringify(emptyStore(), null, 2) + "\n");
    else if (mem !== undefined && copy === null) _writeTrusted(file, mem); // re-review: put a lost record back
    return store;
  }
  return _withoutForeignApprovals(file, store, read.raw);
}

function _loadUnverified(file: string, rawOut?: { raw: string | null; absent?: boolean }): ApprovalStore {
  // Re-review of 0fd38d0: a regular file only — anything else at the path
  // is "absent" — opened without following a symlink or blocking on a FIFO.
  const r = readRegularFile(file, { follow: true });
  if (r.raw === null) {
    if (rawOut) rawOut.absent = r.absent;
    if (!r.absent && r.error) {
      console.error(`[gryphon/mcp-approvals] couldn't read ${file}; treating as empty: ${r.error.message}`);
    }
    return emptyStore();
  }
  if (rawOut) rawOut.raw = r.raw;
  return _parseApprovals(r.raw, file);
}

function _parseApprovals(raw: string, file: string): ApprovalStore {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error(`[gryphon/mcp-approvals] ${file} is not valid JSON; treating as empty`);
    return emptyStore();
  }
  if (!parsed || typeof parsed !== "object" || !parsed.vaults || typeof parsed.vaults !== "object" || Array.isArray(parsed.vaults)) {
    console.error(`[gryphon/mcp-approvals] ${file} has an unexpected shape; treating as empty`);
    return emptyStore();
  }
  // Keep only well-formed entries; a malformed one is simply not approved.
  const vaults: ApprovalStore["vaults"] = Object.create(null);
  for (const [vk, servers] of Object.entries(parsed.vaults)) {
    if (!_validVaultKey(vk)) continue;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, entry] of Object.entries(servers as Record<string, any>)) {
      if (!isApprovableName(name)) continue;
      if (!entry || typeof entry !== "object" || typeof entry.sha256 !== "string" || !HASH_RE.test(entry.sha256)) continue;
      (vaults[vk] = vaults[vk] || Object.create(null))[name] = {
        sha256: entry.sha256,
        approvedAt: typeof entry.approvedAt === "string" ? entry.approvedAt : "",
      };
    }
  }
  return { version: STORE_VERSION, vaults };
}

function _lookup(store: ApprovalStore, vk: string, name: string): string | null {
  if (!isApprovableName(name)) return null;
  const servers = store && store.vaults && Object.prototype.hasOwnProperty.call(store.vaults, vk) ? store.vaults[vk] : null;
  const entry = servers && Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : null;
  return entry ? entry.sha256 : null;
}

function isApproved(store: ApprovalStore, vk: string, name: string, specHash: string): boolean {
  return typeof specHash === "string" && HASH_RE.test(specHash) && _lookup(store, vk, name) === specHash;
}

function listForVault(store: ApprovalStore, vk: string): Array<{ name: string; sha256: string; approvedAt: string }> {
  const servers = (store && store.vaults && Object.prototype.hasOwnProperty.call(store.vaults, vk) && store.vaults[vk]) || {};
  return Object.keys(servers).sort().map((name) => ({ name, ...servers[name] }));
}

/** Atomic write: 0700 dir, 0600 temp file in the same dir, rename over. */
function _save(store: ApprovalStore, file: string) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask and ignored for an existing dir.
  if (process.platform !== "win32") { try { fs.chmodSync(dir, 0o700); } catch (_) {} }
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const raw = JSON.stringify(store, null, 2) + "\n";
  // Issue #32: remembered before the rename in this process, so no reader
  // here judges Gryphon's own write as foreign; the trusted copy only once
  // the store holds it (a failed rename must not leave the copy ahead).
  _ownWrite().raw = raw;
  fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  _writeTrusted(file, raw);
  // Security review: the fast path above covers only the moment between
  // the rename and the record; left set, these exact bytes could be
  // replayed later, after the user changed the approvals elsewhere.
  if (_ownWrite().raw === raw) _ownWrite().raw = null;
}

// ── outside changes (issue #32) ─────────────────────────────────────────

/**
 * Issue #32, applied to this store: an approval lets a vault's MCP server
 * start with no click, so one added outside Gryphon — mid-reply, or by a
 * write delayed past it, or while Gryphon wasn't running — must not count.
 * Every read compares the file to the content Gryphon itself last wrote
 * (this process's latest write, or the trusted copy kept beside the store,
 * which survives a restart and is shared across processes). An approval
 * that isn't in that content (added, or its hash changed) is dropped before
 * the lookup sees it, the file is put back, and the user is told. Removals
 * only take protection away from a server, so they stand.
 */
const TRUSTED_NAME = ".mcp-approvals.trusted.json";
const OWN_WRITE_KEY = Symbol.for("gryphon.mcpApprovalsWrites");

// `raw`: Gryphon's latest write here. `accepted`: the last content accepted
// as Gryphon's, per file — it backs the on-disk copy (deleting the copy
// mid-session gains nothing).
function _ownWrite(): { raw: string | null; accepted: Map<string, string> } {
  const g = process as any;
  if (!g[OWN_WRITE_KEY] || !(g[OWN_WRITE_KEY].accepted instanceof Map)) {
    Object.defineProperty(g, OWN_WRITE_KEY, { value: { raw: null, accepted: new Map() }, configurable: true, enumerable: false, writable: true });
  }
  return g[OWN_WRITE_KEY];
}

function _trustedPath(file: string): string {
  return path.join(path.dirname(file), TRUSTED_NAME);
}


/** The on-disk copy, only as a plain single-link file that isn't the store (security review). */
function _readTrustedCopy(file: string): string | null {
  const r = readRegularFile(_trustedPath(file));
  // Only the store itself (same file) or a non-file is rejected: a hard
  // link to some other file gives nothing a direct write wouldn't.
  if (r.raw === null) return null;
  try {
    const s2 = fs.statSync(file);
    if (s2.ino === r.st.ino && s2.dev === r.st.dev) return null;
  } catch (_) { /* no store: nothing to alias */ }
  return r.raw;
}

/** As in the settings store: record "nothing approved" for a missing file, folder created, exclusive create. */
function _initEmptyRecord(file: string, empty: string): void {
  _ownWrite().accepted.set(file, empty);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(_trustedPath(file), empty, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      console.warn(`[gryphon/mcp-approvals] couldn't record the approvals' starting point: ${(e as Error).message}`);
      return;
    }
    if (_readTrustedCopy(file) !== null) return; // another window's valid record
    clearNonFile(_trustedPath(file));
    _writeTrusted(file, empty);
  }
}

function _writeTrusted(file: string, raw: string): void {
  _ownWrite().accepted.set(file, raw);
  const t = _trustedPath(file);
  try {
    if (_readTrustedCopy(file) === raw) return;
    // Re-review: a directory (or anything but a file) at the record's path
    // can't be renamed over — clear it first; it isn't a record Gryphon wrote.
    clearNonFile(t);
    const tmp = `${t}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    try { fs.renameSync(tmp, t); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  } catch (e) {
    console.warn(`[gryphon/mcp-approvals] couldn't record the trusted copy of the approvals: ${(e as Error).message}`);
  }
}

// `info` "record-started": no record of Gryphon's own content existed (first
// run with this version, or deleted while Gryphon wasn't running), so the
// approvals were taken as they are — the user should look.
type ApprovalsTamperSink = (removed: Array<{ vaultKey: string; name: string }>, error: unknown, info?: "record-started") => void;
const _approvalsTamperSinks = new Set<ApprovalsTamperSink>();
const _reportedRemovals = new Set<string>();

/** Approvals added outside Gryphon and removed (or that couldn't be). */
function onApprovalsTamper(fn: ApprovalsTamperSink): () => void {
  _approvalsTamperSinks.add(fn);
  return () => { _approvalsTamperSinks.delete(fn); };
}

/**
 * Vaults this process serves (looked up, approved or revoked here), shared
 * by every bundled copy in the process. Each Obsidian vault window is its
 * own process, so another window's vaults are not in this set.
 */
const SERVED_KEY = Symbol.for("gryphon.mcpApprovalsServedVaults");
function _served(): Set<string> {
  const g = process as any;
  if (!(g[SERVED_KEY] instanceof Set)) Object.defineProperty(g, SERVED_KEY, { value: new Set(), configurable: true, enumerable: false, writable: true });
  return g[SERVED_KEY];
}

/** Mark a vault as served here before reading its approvals. */
function serveVault(vk: string): void {
  if (typeof vk === "string" && vk) _served().add(vk);
}

/**
 * What the approvals should be, per vault. A vault this process serves:
 * what this process last accepted (an agent that writes the store can write
 * the copy beside it too). Any other vault: the trusted copy, which another
 * Gryphon window updates with its own writes (review: judging another
 * window's approvals against this process's memory removed them). After a
 * restart (no memory): the copy.
 */
function _approvalsBaseline(mem: string | undefined, copy: string | null, file: string): ApprovalStore {
  const t = _trustedPath(file);
  if (mem === undefined) return _parseApprovals(copy as string, t);
  const out = _parseApprovals(mem, t);
  if (copy === null) return out;
  const c = _parseApprovals(copy, t);
  const served = _served();
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  for (const vk of new Set([...Object.keys(out.vaults), ...Object.keys(c.vaults)])) {
    if (served.has(vk)) continue;
    if (own(c.vaults, vk)) Object.defineProperty(out.vaults, vk, { value: c.vaults[vk], enumerable: true, configurable: true, writable: true });
    else delete out.vaults[vk];
  }
  return out;
}

function _withoutForeignApprovals(file: string, store: ApprovalStore, raw: string): ApprovalStore {
  if (raw === _ownWrite().raw) return store;
  const mem = _ownWrite().accepted.get(file);
  const copy = _readTrustedCopy(file);
  // Re-review: a lost or replaced record is put back from what this window knows.
  if (mem !== undefined && copy === null) _writeTrusted(file, mem);
  if (mem === raw || (mem === undefined && copy === raw)) { _writeTrusted(file, raw); return store; }
  if (mem === undefined && copy === null) {
    // No record anywhere: take it as it is, and say so if it approves anything.
    _writeTrusted(file, raw);
    if (Object.keys(store.vaults).length) {
      const approved = Object.entries(store.vaults).flatMap(([vk, servers]) => Object.keys(servers).map((name) => ({ vaultKey: vk, name })));
      for (const fn of _approvalsTamperSinks) {
        try { fn(approved, null, "record-started"); } catch (_) { /* a sink must not break reads */ }
      }
    }
    return store;
  }
  const trusted = _approvalsBaseline(mem, copy, file);
  const removed: Array<{ vaultKey: string; name: string }> = [];
  for (const [vk, servers] of Object.entries(store.vaults)) {
    for (const name of Object.keys(servers)) {
      if (_lookup(trusted, vk, name) === servers[name].sha256) continue;
      removed.push({ vaultKey: vk, name });
      delete servers[name];
    }
    if (!Object.keys(servers).length) delete store.vaults[vk];
  }
  if (!removed.length) {
    // Only removals: what's there is now the baseline.
    _writeTrusted(file, raw);
    return store;
  }
  let error: unknown = null;
  try { _save(store, file); } catch (e) { error = e; }
  const tag = `${raw.length}:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  if (!_reportedRemovals.has(tag)) {
    _reportedRemovals.add(tag);
    console.warn(
      "[gryphon/mcp-approvals] removed MCP server approvals added outside Gryphon: " +
      removed.map((r) => displaySafe(r.name)).join(", ") + (error ? ` (couldn't save the fix: ${(error as Error).message})` : ""),
    );
    for (const fn of _approvalsTamperSinks) {
      try { fn(removed, error); } catch (_) { /* a sink must not break reads */ }
    }
  }
  return store;
}

function approve(vk: string, name: string, specHash: string, opts: { file?: string; now?: Date } = {}) {
  serveVault(vk);
  if (!HASH_RE.test(String(specHash))) throw new Error("mcp-approvals: specHash must be a sha256 hex digest");
  if (!isApprovableName(name)) throw new Error(`mcp-approvals: a server named ${JSON.stringify(name)} can't be approved — rename it in .mcp.json`);
  const file = opts.file || approvalsFilePath();
  const store = load(file);
  if (!_validVaultKey(vk)) throw new Error("mcp-approvals: invalid vault key");
  (store.vaults[vk] = store.vaults[vk] || Object.create(null))[name] = {
    sha256: specHash,
    approvedAt: (opts.now || new Date()).toISOString(),
  };
  _save(store, file);
}

function revoke(vk: string, name: string, opts: { file?: string } = {}) {
  serveVault(vk);
  const file = opts.file || approvalsFilePath();
  const store = load(file);
  if (!store.vaults[vk] || !store.vaults[vk][name]) return;
  delete store.vaults[vk][name];
  if (Object.keys(store.vaults[vk]).length === 0) delete store.vaults[vk];
  _save(store, file);
}

/**
 * The reader the provider injects into the scope resolver: re-reads the
 * file on every lookup, so an approval made in the modal applies on the
 * very next spawn with no cache to invalidate.
 */
function reader(opts: { file?: string } = {}) {
  const file = opts.file || approvalsFilePath();
  return { lookup: (vk: string, name: string): string | null => { serveVault(vk); return _lookup(load(file), vk, name); } };
}

// ── guardrail helpers (used by the attack detector) ───────────────────

function _norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** realpath of the deepest existing ancestor + the not-yet-existing tail. */
function _realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch (_) {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.push(path.basename(cur));
    cur = parent;
  }
  return p;
}

/**
 * Extra directories guarded alongside `approvalsDir()` — issue #30: the
 * store-guard hook passes the dir Gryphon actually writes, so a tampered
 * XDG_CONFIG_HOME / APPDATA in the agent's environment can't move the
 * target away from it. Only ever widens what's guarded.
 */
type GuardOpts = LocateOpts & {
  extraDirs?: string[];
  /** Absolute ms time past which a check gives up and refuses (the hook's deadline). */
  deadlineAt?: number;
};

/**
 * Per-check state (E7-1 / P8-1): the guarded dirs and their identities are
 * computed ONCE per verdict, ancestor stats are cached, and the number of
 * path resolutions is budgeted — past the budget or the deadline the call is
 * refused as uninspectable rather than allowed (a killed hook is "allow" in
 * several CLIs).
 */
type GuardCtx = {
  opts: GuardOpts;
  norms: string[];
  ids: Set<string>;
  storeFileIds: Set<string>;
  cache: Map<string, string | null>;
  budget: number;
};
const MAX_RESOLUTIONS = 4000;

class TooLargeToInspect extends Error {}

function _guardCtx(opts: GuardOpts): GuardCtx {
  const cache = new Map<string, string | null>();
  const guarded = _guardedDirs(opts);
  const norms = new Set<string>();
  const ids = new Set<string>();
  const storeFileIds = new Set<string>();
  for (const dir of guarded) {
    norms.add(_norm(dir)); norms.add(_norm(_realish(dir)));
    const id = fileIdCached(dir, cache); if (id) ids.add(id);
    for (const f of ["mcp-approvals.json", ".mcp-approvals.trusted.json", "security-settings.json", ".security-settings.trusted.json"]) {
      const fid = fileIdCached(path.join(dir, f), cache); if (fid) storeFileIds.add(fid);
    }
  }
  return { opts, norms: [...norms], ids, storeFileIds, cache, budget: MAX_RESOLUTIONS };
}

function _spend(ctx: GuardCtx): void {
  if (--ctx.budget < 0) throw new TooLargeToInspect("too many paths to inspect");
  if (typeof ctx.opts.deadlineAt === "number" && Date.now() > ctx.opts.deadlineAt) {
    throw new TooLargeToInspect("took too long to inspect");
  }
}

/** The store check against a precomputed context (see isApprovalsStorePath). */
function _isStorePath(absPath: string, ctx: GuardCtx): boolean {
  if (typeof absPath !== "string" || !absPath) return false;
  _spend(ctx);
  // R2-1: three spellings — as given, `..` collapsed lexically (what the
  // writing tool does), and resolved on disk (what the kernel does when a
  // symlink precedes the `..`).
  const real = _realish(absPath);
  const spellings = [...new Set([absPath, path.resolve(absPath), real])];
  for (const c of spellings.map(_norm)) {
    for (const d of ctx.norms) if (c === d || c.startsWith(d + "/")) return true;
  }
  // R43-6: the same dir or file under another name (macOS firmlinks,
  // Windows \\?\ / \\localhost\C$ / 8.3 names, hard links).
  for (const c of spellings) {
    if (isWithinIds(c, ctx.ids, ctx.cache)) return true;
    const id = fileIdCached(c, ctx.cache);
    if (id && ctx.storeFileIds.has(id)) return true;
  }
  return false;
}

function _guardedDirs(opts: GuardOpts): string[] {
  const extra = Array.isArray(opts.extraDirs) ? opts.extraDirs.filter((d) => typeof d === "string" && path.isAbsolute(d)) : [];
  return [approvalsDir(opts), ...extra];
}

/**
 * True when `absPath` is the approval store's directory or anything inside
 * it. Case-insensitive (macOS / Windows filesystems are), and compared both
 * lexically and through symlinks so `/tmp` ↔ `/private/tmp` style aliases
 * don't slip past.
 */
function isApprovalsStorePath(absPath: string, opts: GuardOpts = {}): boolean {
  try { return _isStorePath(absPath, _guardCtx(opts)); } catch (e) {
    if (e instanceof TooLargeToInspect) return true; // can't tell → treat as the store
    throw e;
  }
}

/**
 * Shell commands that name the store. A best-effort lexical check, like
 * every other protected-command pattern: either store file's name anywhere
 * (`mcp-approvals.json`, and issue #29's `security-settings.json`), or the
 * store directory spelled any of the usual ways on each OS. It is NOT a
 * barrier against a model that already has a shell (see the header).
 */
const STORE_COMMAND_RE = /mcp-approvals|security-settings(?:\.trusted)?\.json|(?:\.config|XDG_CONFIG_HOME\}?|AppData[\\/]+Roaming|%APPDATA%|\$env:APPDATA|\$\{?APPDATA\}?)["']?[\\/]+["']?gryphon\b/i;

function mentionsApprovalsStore(command: string, opts: GuardOpts = {}): boolean {
  if (typeof command !== "string" || !command) return false;
  if (STORE_COMMAND_RE.test(command)) return true;
  // The literal resolved directory, for a custom XDG_CONFIG_HOME / APPDATA.
  const text = command.replace(/\\/g, "/").toLowerCase();
  return _guardedDirs(opts).some((d) => text.includes(_norm(d)));
}

// ── the store rule (issue #30: shared by classify and the store-guard hook) ──

/** Read-only tools: never gated, even when they name the store. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** Argument names that may carry a target path, across CLIs and MCP tools. */
// Content-ish names (`new_source`, `content`, `new_string`) are left out on
// purpose: a note that MENTIONS the store path must not be refused.
const PATH_ARG_RE = /path|file|target|dest|dst|dir|uri|url|location|cwd|^(?:source|src|to|from|output|out|folders?)$/i;
/** Names of a directory that relative path arguments may resolve against. */
const BASE_ARG_RE = /cwd|dir(?:ectory)?s?$|folders?$|^(?:root|base)$/i;
/**
 * Argument names that carry a command line (issue #28), checked lexically
 * like Bash. Matched per word of the key, so `shellCommand`, `run_cmd` and
 * `tool-args` all count.
 */
const COMMAND_WORDS = new Set(["command", "cmd", "cmdline", "script", "code", "args", "argv", "shell", "exec", "program"]);
function _isCommandKey(key: string): boolean {
  return key.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z\d]+/).some((w) => COMMAND_WORDS.has(w));
}
/** The first, cheap pass. A call past these bounds is walked again in full. */
const WALK_MAX_DEPTH = 4;
const WALK_MAX_STRINGS = 256;
/** The full pass's caps: tool input past them is refused, not waved through. */
const WALK_HARD_DEPTH = 64;
const WALK_HARD_STRINGS = 10000;
const MAX_BASES = 32;

/**
 * The string arguments of a tool call as `[key, value]` pairs, walked to a
 * bounded depth and count. An array of strings stays one entry under the
 * key that holds it (so `args: ["sh","-c","…"]` can be read as one command
 * line); an object's properties go under their own keys, so
 * `{edits: [{file_path}]}` reaches `file_path`. `truncated` is set when a
 * bound cut the walk short — the caller must not read that as "clean".
 */
function _argStrings(input: Record<string, unknown>, maxDepth: number, maxStrings: number): { pairs: Array<[string, string | string[]]>; truncated: boolean } {
  const pairs: Array<[string, string | string[]]> = [];
  let budget = maxStrings;
  let truncated = false;
  // #34 / 2.11.1 QA: only strings under keys that can name a path, a base
  // dir or a command are collected and counted — page text, block content
  // and other data never matter here, and counting them made a big MCP
  // payload hit the limit and be refused outright.
  const relevant = (key: string) => PATH_ARG_RE.test(key) || BASE_ARG_RE.test(key) || _isCommandKey(key);
  const walk = (key: string, v: unknown, depth: number) => {
    if (depth > maxDepth) { truncated = true; return; }
    if (typeof v === "string") {
      if (!v || !relevant(key)) return;
      if (budget <= 0) { truncated = true; return; }
      budget--; pairs.push([key, v]); return;
    }
    if (Array.isArray(v)) {
      const all = relevant(key) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
      const strs = all.slice(0, Math.max(0, budget));
      if (strs.length < all.length) truncated = true;
      if (strs.length > 0) { budget -= strs.length; pairs.push([key, strs]); }
      for (const x of v) if (x && typeof x === "object") walk(key, x, depth + 1);
      return;
    }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(k, x, depth + 1);
  };
  for (const [k, v] of Object.entries(input)) walk(k, v, 1);
  return { pairs, truncated };
}

/**
 * A path argument → the absolute paths it could name: resolved against the
 * vault and against every cwd-like argument of the same call. `file:` URLs
 * are converted; any other `scheme:` value is still resolved as a path
 * (harmless for a real URL, and `ab:/../../…` is a relative path to a tool).
 */
function _resolveArgPaths(value: string, bases: string[]): string[] {
  if (/^file:/i.test(value)) {
    try { return [require("url").fileURLToPath(value)]; } catch (_) { return []; }
  }
  if (/^~(?=$|[\\/])/.test(value)) return [path.join(os.homedir(), value.slice(1))];
  if (path.isAbsolute(value)) return [value];
  return bases.map((b) => path.resolve(b, value));
}

// Normalize command strings before regex matching. NFKC collapses
// Unicode compatibility characters (fullwidth `ｒｍ` → ASCII `rm`),
// and the second pass strips zero-width characters that would otherwise
// break `\brm\b` style boundaries ("r​m" with a ZWSP in the middle).
function normalizeForMatch(s: unknown): string {
  return String(s)
    .normalize("NFKC")
    .replace(/[​-‍﻿⁠]/g, "");
}

function _fileToolVerdict(input: Record<string, unknown>, cwd: string | null, opts: GuardOpts): string | null {
  // Cheap pass first; past its bounds (padding, deep nesting) walk the whole
  // call, so the bound limits work, never coverage.
  let walked = _argStrings(input, WALK_MAX_DEPTH, WALK_MAX_STRINGS);
  if (walked.truncated) {
    walked = _argStrings(input, WALK_HARD_DEPTH, WALK_HARD_STRINGS);
    if (walked.truncated) return `Arguments:       too large to inspect`;
  }
  const rootBases = cwd ? [cwd] : [];
  const baseSet = new Set(rootBases);
  for (const [key, value] of walked.pairs) {
    if (!BASE_ARG_RE.test(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) for (const b of _resolveArgPaths(v, rootBases)) baseSet.add(b);
  }
  if (baseSet.size > MAX_BASES) return `Arguments:       too many directories to inspect`;
  const bases = [...baseSet];
  const ctx = _guardCtx(opts);
  for (const [key, value] of walked.pairs) {
    if (PATH_ARG_RE.test(key)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        try {
          if (_resolveArgPaths(v, bases).some((abs) => _isStorePath(abs, ctx))) return `Target path:     ${v}`;
        } catch (e) {
          if (e instanceof TooLargeToInspect) return `Arguments:       ${e.message}`;
          throw e;
        }
      }
    }
    if (_isCommandKey(key)) {
      const raw = Array.isArray(value) ? value.join(" ") : value;
      if (mentionsApprovalsStore(normalizeForMatch(raw), opts)) return `Command:         ${raw}`;
    }
  }
  return null;
}

/**
 * Issue #30: the approvals-store rule as one pure function. `classify` and
 * the store-guard hook both call it, so the two can't disagree (A8).
 *
 * Returns `{ tool, what }` — the canonical tool name and a one-line
 * description of what matched — when the call writes, edits or runs a
 * command aimed at Gryphon's own trust stores; null otherwise. Read-only
 * tools are never matched. Any tool that isn't read-only or a shell is
 * walked for path-like and command-like arguments, nested ones included,
 * so a tool missing from TOOL_ALIASES can't write the store by default.
 *
 * `cwd` is the directory relative path arguments resolve against (the vault
 * for classify, the CLI's reported cwd for the hook). `extraDirs` widens
 * the guarded set (see GuardOpts). Depends only on node builtins and the
 * alias table, so it bundles into the standalone hook.
 */
function approvalsStoreVerdict(
  tool: string, input: Record<string, unknown> | null | undefined,
  opts: GuardOpts & { cwd?: string | null } = {},
): { tool: string; what: string } | null {
  if (typeof tool !== "string" || !tool || !input || typeof input !== "object") return null;
  const canonical = TOOL_ALIASES[tool] || tool;
  if (READ_ONLY_TOOLS.has(canonical)) return null;
  if (canonical === "Bash" || canonical === "PowerShell") {
    // An argv-style array is checked as one command line, never skipped.
    const raw = typeof input.command === "string" ? input.command
      : Array.isArray(input.command) ? input.command.map(String).join(" ") : "";
    if (raw && mentionsApprovalsStore(normalizeForMatch(raw), opts)) {
      return { tool: canonical, what: `Command:         ${raw}` };
    }
    // R43-3: `apply_patch <<'EOF' … EOF` run as a shell command — Codex
    // applies it itself, so its file headers are path targets too, resolved
    // from the call's own dir args and any `cd` in the command as well.
    const info = raw ? patchTargetsInfo(raw) : { targets: [], truncated: false };
    if (info.truncated) return { tool: canonical, what: `Patch:           too many files to inspect` };
    if (!info.targets.length) return null;
    const viaPatch = _fileToolVerdict(
      { ...input, command: undefined, patch_target_paths: info.targets, cd_dirs: shellCdDirs(raw) },
      typeof opts.cwd === "string" && opts.cwd ? opts.cwd : null, opts,
    );
    return viaPatch ? { tool: canonical, what: viaPatch } : null;
  }
  // R43-3: a Codex apply_patch names its files in the patch text — those
  // headers are path arguments too, resolved (with symlinks) like any
  // Write/Edit target. ONLY for apply_patch: a note's content or an MCP
  // payload that merely contains patch-like lines is not a patch (review of
  // 2.11.1: a Write documenting the syntax was refused outright).
  let checked = input;
  if (tool === "apply_patch") {
    const info = patchTargetsInfo(input);
    if (info.truncated) return { tool: canonical, what: `Patch:           too many files to inspect` };
    if (info.targets.length) checked = { ...input, patch_target_paths: info.targets };
  }
  const what = _fileToolVerdict(checked, typeof opts.cwd === "string" && opts.cwd ? opts.cwd : null, opts);
  return what ? { tool: canonical, what } : null;
}

module.exports = {
  onApprovalsTamper,
  serveVault,
  approvalsDir,
  approvalsFilePath,
  canonicalJSON,
  hashSpec,
  vaultKey,
  isApprovableName,
  displaySafe,
  load,
  isApproved,
  listForVault,
  approve,
  revoke,
  reader,
  isApprovalsStorePath,
  mentionsApprovalsStore,
  approvalsStoreVerdict,
  normalizeForMatch,
  // #34: the same argument walker / path-key test for classify's
  // name-independent default.
  _argStrings,
  _resolveArgPaths,
  PATH_ARG_RE,
  BASE_ARG_RE,
  STORE_COMMAND_RE,
};
