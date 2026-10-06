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
 * `<vault>/.obsidian/plugins/gryphon/` and travels with the vault.
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

/**
 * A vault-supplied string made safe to show: Cc / bidi / zero-width /
 * line-separator characters become visible `\u{XXXX}` escapes, so a server
 * name or value can't reorder or hide text in a Notice or the review modal
 * (an RLO in a name, a newline faking a second line).
 */
function _isUnsafeChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
}

function displaySafe(v: unknown): string {
  let out = "";
  for (const ch of String(v)) {
    const code = ch.codePointAt(0)!;
    out += _isUnsafeChar(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}` : ch;
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
 * True when `absPath` is the approval store's directory or anything inside
 * it. Case-insensitive (macOS / Windows filesystems are), and compared both
 * lexically and through symlinks so `/tmp` ↔ `/private/tmp` style aliases
 * don't slip past.
 */
function isApprovalsStorePath(absPath: string, opts: LocateOpts = {}): boolean {
  if (typeof absPath !== "string" || !absPath) return false;
  const dir = approvalsDir(opts);
  const dirs = new Set([_norm(dir), _norm(_realish(dir))]);
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
 * every other protected-command pattern: the file name anywhere, or the
 * store directory spelled any of the usual ways on each OS. It is NOT a
 * barrier against a model that already has a shell (see the header).
 */
const STORE_COMMAND_RE = /mcp-approvals|(?:\.config|XDG_CONFIG_HOME\}?|AppData[\\/]+Roaming|%APPDATA%|\$env:APPDATA|\$\{?APPDATA\}?)["']?[\\/]+["']?gryphon\b/i;

function mentionsApprovalsStore(command: string, opts: LocateOpts = {}): boolean {
  if (typeof command !== "string" || !command) return false;
  if (STORE_COMMAND_RE.test(command)) return true;
  // The literal resolved directory, for a custom XDG_CONFIG_HOME / APPDATA.
  return command.replace(/\\/g, "/").toLowerCase().includes(_norm(approvalsDir(opts)));
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
  STORE_COMMAND_RE,
};
