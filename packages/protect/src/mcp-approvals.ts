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
const { TOOL_ALIASES } = require("./tool-aliases");

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
  return { version: STORE_VERSION, vaults: {} };
}

/**
 * Read the store. Missing → empty. Unreadable / corrupt → empty AND a log
 * line: fail closed (nothing approved) rather than guess.
 */
function load(file: string = approvalsFilePath()): ApprovalStore {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[gryphon/mcp-approvals] couldn't read ${file}; treating as empty: ${(e as Error).message}`);
    }
    return emptyStore();
  }
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
  const vaults: ApprovalStore["vaults"] = {};
  for (const [vk, servers] of Object.entries(parsed.vaults)) {
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, entry] of Object.entries(servers as Record<string, any>)) {
      if (!isApprovableName(name)) continue;
      if (!entry || typeof entry !== "object" || typeof entry.sha256 !== "string" || !HASH_RE.test(entry.sha256)) continue;
      (vaults[vk] = vaults[vk] || {})[name] = {
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
  const servers = (store && store.vaults && store.vaults[vk]) || {};
  return Object.keys(servers).sort().map((name) => ({ name, ...servers[name] }));
}

/** Atomic write: 0700 dir, 0600 temp file in the same dir, rename over. */
function _save(store: ApprovalStore, file: string) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask and ignored for an existing dir.
  if (process.platform !== "win32") { try { fs.chmodSync(dir, 0o700); } catch (_) {} }
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function approve(vk: string, name: string, specHash: string, opts: { file?: string; now?: Date } = {}) {
  if (!HASH_RE.test(String(specHash))) throw new Error("mcp-approvals: specHash must be a sha256 hex digest");
  if (!isApprovableName(name)) throw new Error(`mcp-approvals: a server named ${JSON.stringify(name)} can't be approved — rename it in .mcp.json`);
  const file = opts.file || approvalsFilePath();
  const store = load(file);
  (store.vaults[vk] = store.vaults[vk] || {})[name] = {
    sha256: specHash,
    approvedAt: (opts.now || new Date()).toISOString(),
  };
  _save(store, file);
}

function revoke(vk: string, name: string, opts: { file?: string } = {}) {
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
  return { lookup: (vk: string, name: string): string | null => _lookup(load(file), vk, name) };
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
type GuardOpts = LocateOpts & { extraDirs?: string[] };

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
  if (typeof absPath !== "string" || !absPath) return false;
  const dirs = new Set<string>();
  for (const dir of _guardedDirs(opts)) { dirs.add(_norm(dir)); dirs.add(_norm(_realish(dir))); }
  const cands = [_norm(absPath), _norm(_realish(absPath))];
  for (const c of cands) {
    for (const d of dirs) {
      if (c === d || c.startsWith(d + "/")) return true;
    }
  }
  return false;
}

/**
 * Shell commands that name the store. A best-effort lexical check, like
 * every other protected-command pattern: either store file's name anywhere
 * (`mcp-approvals.json`, and issue #29's `security-settings.json`), or the
 * store directory spelled any of the usual ways on each OS. It is NOT a
 * barrier against a model that already has a shell (see the header).
 */
const STORE_COMMAND_RE = /mcp-approvals|security-settings\.json|(?:\.config|XDG_CONFIG_HOME\}?|AppData[\\/]+Roaming|%APPDATA%|\$env:APPDATA|\$\{?APPDATA\}?)["']?[\\/]+["']?gryphon\b/i;

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
  const walk = (key: string, v: unknown, depth: number) => {
    if (budget <= 0 || depth > maxDepth) { truncated = true; return; }
    if (typeof v === "string") { if (v) { budget--; pairs.push([key, v]); } return; }
    if (Array.isArray(v)) {
      const all = v.filter((x): x is string => typeof x === "string" && !!x);
      const strs = all.slice(0, budget);
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
  for (const [key, value] of walked.pairs) {
    if (PATH_ARG_RE.test(key)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (_resolveArgPaths(v, bases).some((abs) => isApprovalsStorePath(abs, opts))) return `Target path:     ${v}`;
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
    const raw = typeof input.command === "string" ? input.command : "";
    return raw && mentionsApprovalsStore(normalizeForMatch(raw), opts)
      ? { tool: canonical, what: `Command:         ${raw}` }
      : null;
  }
  const what = _fileToolVerdict(input, typeof opts.cwd === "string" && opts.cwd ? opts.cwd : null, opts);
  return what ? { tool: canonical, what } : null;
}

module.exports = {
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
  STORE_COMMAND_RE,
};
