"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
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
const fs = require("fs");
const { isWithinByIdentity } = require("./path-identity");
const { readRegularFile, clearNonFile } = require("./safe-read");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
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
]);
const DEFAULTS = Object.freeze({
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
const BOOLEAN_KEYS = new Set(["protectedMode", "protectedPathsEnabled", "protectedCommandsEnabled", "blockPackageInstall", "claudeCodeInheritUserConfig"]);
const KEY_SET = new Set(WEAKENING_KEYS);
/** Issue #30: the CLI binary paths — machine-scoped, never read from data.json. */
const EXECUTABLE_KEYS = Object.freeze(["claudePath", "codexPath", "geminiCliPath", "antigravityPath"]);
const EXECUTABLE_KEY_SET = new Set(EXECUTABLE_KEYS);
const CLI_PATH_KEY_BY_KIND = Object.freeze({
    "claude-code": "claudePath",
    "codex-cli": "codexPath",
    "gemini-cli": "geminiCliPath",
    "antigravity-cli": "antigravityPath",
});
function isExecutableKey(key) {
    return typeof key === "string" && EXECUTABLE_KEY_SET.has(key);
}
function _patternsOf(defs) {
    return new Set(defs.map((d) => (typeof d === "string" ? d : d && d.pattern)).filter((p) => typeof p === "string"));
}
const KNOWN_DISABLED = {
    protectedPathsDisabled: _patternsOf(DEFAULT_PROTECTED_PATHS),
    protectedCommandsDisabled: _patternsOf(DEFAULT_PROTECTED_COMMANDS),
};
function isWeakeningKey(key) {
    return typeof key === "string" && KEY_SET.has(key);
}
/**
 * `{ ok: true, value }` with the normalized value, or `{ ok: false, reason }`.
 * A `*Disabled` list keeps only entries naming a built-in pattern: disabling
 * a pattern that doesn't exist does nothing, so dropping it changes nothing.
 */
function validateSecurityValue(key, value) {
    if (!isWeakeningKey(key))
        return { ok: false, reason: `unknown key ${JSON.stringify(key)}` };
    if (BOOLEAN_KEYS.has(key)) {
        return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: `${key} must be true or false` };
    }
    if (key === "permissionMode") {
        return typeof value === "string" && PERMISSION_MODES.has(value)
            ? { ok: true, value }
            // Review R7-1: never serialise an untrusted value here — a deeply nested
            // one overflowed the stack inside the tamper check.
            : { ok: false, reason: `unknown permissionMode ${typeof value === "string" ? JSON.stringify(value.slice(0, 64)) : typeof value}` };
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
function isWeakening(key, value) {
    const v = validateSecurityValue(key, value);
    if (!v.ok)
        return false;
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
function hashValue(value) {
    return mcpApprovals.hashSpec(value);
}
function securitySettingsFilePath(opts = {}) {
    const dir = mcpApprovals.approvalsDir(opts);
    return (opts.platform || process.platform) === "win32" ? path.win32.join(dir, FILE_NAME) : path.join(dir, FILE_NAME);
}
// ── scope ──────────────────────────────────────────────────────────────
class SecurityScopeUnavailableError extends Error {
    missing;
    constructor(missing) {
        super("Can't save this security setting: Gryphon couldn't identify this vault/host. Protections stay on." +
            ` (missing: ${missing})`);
        this.name = "SecurityScopeUnavailableError";
        this.missing = missing;
    }
}
function _validName(v) {
    return typeof v === "string" && v.length > 0 && !RESERVED_NAMES.has(v);
}
/**
 * The store scope for a host, or why there isn't one. Uses the host's
 * `app.vault.adapter` base path and its manifest id — never
 * `_vaultRoot()`, which embedders don't have.
 */
function describeSecurityScope(input = {}) {
    const app = input.app || (input.hostPlugin && input.hostPlugin.app);
    if (!app)
        return { scope: null, missing: "app" };
    const adapter = app.vault && app.vault.adapter;
    let basePath = null;
    try {
        basePath = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter && adapter.basePath;
    }
    catch (_) {
        basePath = null;
    }
    if (typeof basePath !== "string" || !basePath)
        return { scope: null, missing: "basePath" };
    // Host id precedence: explicit option > the host's own code-set
    // `securityHostId`. Never manifest.id (issue #30, G3): the manifest ships
    // inside the vault (.obsidian/plugins/<dir>/manifest.json), so a vault
    // could rename it to another host's id and inherit that host's confirmed
    // weakening values. With neither, there's no scope and reads fail closed.
    const hp = input.hostPlugin;
    const hostId = input.hostId !== undefined && input.hostId !== null
        ? input.hostId
        : (hp && typeof hp.securityHostId === "string" && hp.securityHostId) || null;
    if (!_validName(hostId))
        return { scope: null, missing: "hostId" };
    return { scope: { vaultKey: mcpApprovals.vaultKey(basePath), hostId }, missing: null };
}
function resolveSecurityScope(input = {}) {
    return describeSecurityScope(input).scope;
}
function scopeKey(scope) {
    return scope ? `${scope.vaultKey}\u0000${scope.hostId}` : null;
}
const _errorSinks = new Set();
const _reported = new Set();
/**
 * Register a sink for store read errors (the plugin shows a Notice). Each
 * distinct error is reported once per file version. Returns an unsubscribe.
 */
function onSecurityStoreError(fn) {
    _errorSinks.add(fn);
    return () => { _errorSinks.delete(fn); };
}
function _report(file, stamp, message) {
    console.error(`[gryphon/security-settings] ${message}`);
    const key = `${file}\u0000${stamp}\u0000${message}`;
    if (_reported.has(key))
        return;
    _reported.add(key);
    for (const fn of _errorSinks) {
        try {
            fn(message, file);
        }
        catch (_) { /* a sink must not break reads */ }
    }
}
function _empty() { return { version: STORE_VERSION, vaults: Object.create(null) }; }
function _parse(raw, file, stamp, report = _report) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (_) {
        report(file, stamp, `${file} is not valid JSON; every security setting uses its protected default`);
        return _empty();
    }
    // Review R7-1: nothing below may recurse into an arbitrarily deep value.
    if (parsed && typeof parsed === "object")
        _pruneDeep(parsed);
    if (!parsed || typeof parsed !== "object" || !parsed.vaults || typeof parsed.vaults !== "object" || Array.isArray(parsed.vaults)) {
        report(file, stamp, `${file} has an unexpected shape; every security setting uses its protected default`);
        return _empty();
    }
    const store = _empty();
    for (const [vk, vault] of Object.entries(parsed.vaults)) {
        if (!_validName(vk) || !vault || typeof vault !== "object" || !vault.hosts || typeof vault.hosts !== "object")
            continue;
        for (const [hostId, entry] of Object.entries(vault.hosts)) {
            if (!_validName(hostId) || !entry || typeof entry !== "object")
                continue;
            const values = {};
            const rawValues = entry.values && typeof entry.values === "object" && !Array.isArray(entry.values) ? entry.values : {};
            for (const [k, v] of Object.entries(rawValues)) {
                const ok = validateSecurityValue(k, v);
                if (ok.ok)
                    values[k] = ok.value;
                else
                    report(file, stamp, `${file}: dropped ${JSON.stringify(k)} (${ok.reason}); it uses its protected default`);
            }
            const dismissed = {};
            const rawDismissed = entry.dismissed && typeof entry.dismissed === "object" ? entry.dismissed : {};
            for (const [k, h] of Object.entries(rawDismissed)) {
                if ((isWeakeningKey(k) || isExecutableKey(k)) && typeof h === "string" && HASH_RE.test(h))
                    dismissed[k] = h;
            }
            // Paths are only shape-checked here; resolveCliPath re-validates the
            // file itself on every use (it can change after it was confirmed).
            const paths = {};
            const rawPaths = entry.paths && typeof entry.paths === "object" && !Array.isArray(entry.paths) ? entry.paths : {};
            for (const [k, v] of Object.entries(rawPaths)) {
                if (isExecutableKey(k) && typeof v === "string" && v && _isAbsoluteAnywhere(v))
                    paths[k] = v;
                else
                    report(file, stamp, `${file}: dropped CLI path ${JSON.stringify(k)}; it uses the detected binary`);
            }
            if (!store.vaults[vk])
                store.vaults[vk] = { hosts: Object.create(null) };
            store.vaults[vk].hosts[hostId] = { values, setAt: typeof entry.setAt === "string" ? entry.setAt : "", dismissed, paths };
        }
    }
    return store;
}
let _cache = null;
function _stampOf(st) {
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
}
/** Read the store. Cached on (inode, size, mtime): one `stat` per lookup. */
/**
 * Re-review: on every lookup, a record this window knows but that is gone
 * from disk (deleted, replaced by a folder or a link) is put back — so
 * breaking it while Gryphon runs doesn't leave a restart with no record.
 */
function _ensureRecord(file) {
    const mem = _lastTrusted().get(file);
    if (mem !== undefined && _readTrustedCopy(file) === null)
        _writeTrusted(file, mem);
}
function _load(file, fresh = false) {
    _ensureRecord(file);
    // Re-review of 0fd38d0: one safe read — a regular file only (anything
    // else at the path is "absent"), opened without following a symlink and
    // without blocking on a FIFO.
    const r = readRegularFile(file, { follow: true });
    if (r.raw === null) {
        _cache = null;
        const kept = _missingStore(file, r.absent);
        if (kept !== null)
            return _parse(kept, file, "trusted");
        if (!r.absent && r.error) {
            _report(file, "read", `couldn't read ${file}; every security setting uses its protected default: ${r.error.message}`);
        }
        return _empty();
    }
    const raw = r.raw;
    const stamp = _stampOf(r.st);
    // Security review: cached by CONTENT, not by (inode, size, mtime) — an
    // in-place write can keep all three, and the turn-start snapshot (which
    // reads the bytes) would then see content no read had judged.
    // Post-push review F4: the cache is per bundled copy, but the record is
    // per process — a hit also needs the shared record unchanged since.
    if (!fresh && _cache && _cache.file === file && _cache.raw === raw &&
        _cache.seq === _ledger().seq && _cache.mem === _lastTrusted().get(file))
        return _cache.store;
    const used = _verifyAgainstTrusted(file, raw);
    if (used !== raw) {
        // The file was judged and rewritten (or must not be trusted): don't
        // cache under the old stamp; the next lookup re-reads what's there now.
        _cache = null;
        return used === null ? _empty() : _parse(used, file, "trusted");
    }
    const store = _parse(raw, file, stamp);
    _cache = { file, stamp, raw, store, seq: _ledger().seq, mem: _lastTrusted().get(file) };
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
function _ledger() {
    // `process` is one object per process — the Obsidian renderer, or headless
    // Node — shared by every module copy loaded in it, and out of reach of an
    // agent subprocess. (window/globalThis would also do in the renderer, but
    // not headless, and the plugin lint rules steer away from both.)
    const g = process;
    if (!g[LEDGER_KEY] || !Array.isArray(g[LEDGER_KEY].entries)) {
        Object.defineProperty(g, LEDGER_KEY, { value: { seq: 0, entries: [] }, configurable: true, enumerable: false, writable: true });
    }
    return g[LEDGER_KEY];
}
function _recordWrite(raw, priorRaw) {
    const l = _ledger();
    l.seq += 1;
    l.entries.push({ seq: l.seq, sha256: _sha256(raw), raw, priorRaw });
    if (l.entries.length > LEDGER_MAX)
        l.entries.splice(0, l.entries.length - LEDGER_MAX);
}
function _sha256(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
}
/** Atomic write: 0700 dir, 0600 temp file in the same dir, rename over. */
function _save(store, file, priorRaw = null) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        try {
            fs.chmodSync(dir, 0o700);
        }
        catch (_) { }
    }
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    const raw = JSON.stringify(store, null, 2) + "\n";
    // Ledgered BEFORE the rename: a turn-end check racing this write must
    // never see Gryphon's own content as unknown.
    _recordWrite(raw, priorRaw);
    fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    try {
        fs.renameSync(tmp, file);
    }
    catch (e) {
        try {
            fs.unlinkSync(tmp);
        }
        catch (_) { }
        throw e;
    }
    // Issue #32: the trusted copy only once the store holds it (review: a
    // failed rename left the copy ahead, and the next read "undid" the store
    // to a save that never happened). This process's ledger covers the gap.
    _writeTrusted(file, raw);
    _cache = null;
}
// ── the trusted copy (issue #32) ───────────────────────────────────────
/**
 * Issue #32: the turn-end check only compared a reply's start and end, and
 * the next reply took whatever was on disk as its baseline — so a write
 * delayed past the turn (`nohup sh -c 'sleep 120; …' &`) became trusted,
 * and a planted CLI path then ran at the next spawn, even with Protected
 * Mode back on. Now every read that finds the file changed compares it to
 * the content Gryphon itself last wrote: this process's latest write, or
 * the trusted copy every Gryphon writer keeps beside the store (it
 * survives a restart and is shared across processes). Any other change
 * that weakens a setting is undone before the value is used; if it can't
 * be undone, the trusted content is used instead.
 *
 * Within a session the content this process accepted wins; the copy (a
 * plain single-link file, never an alias of the store) stands in only after
 * a restart. An agent that rewrites both files consistently while Gryphon
 * isn't running defeats it — the same-user limit as the store itself
 * (an OS-keychain MAC would raise it). A missing record is reported, never
 * silently adopted.
 */
const TRUSTED_NAME = ".security-settings.trusted.json";
function _trustedPath(file) {
    return path.join(path.dirname(file), TRUSTED_NAME);
}
/**
 * The last content accepted as Gryphon's, per store file, in this process
 * (shared by every bundled copy). It backs the on-disk copy: deleting the
 * copy mid-session gains nothing.
 */
const LAST_TRUSTED_KEY = Symbol.for("gryphon.securityStoreTrusted");
function _lastTrusted() {
    const g = process;
    if (!(g[LAST_TRUSTED_KEY] instanceof Map)) {
        Object.defineProperty(g, LAST_TRUSTED_KEY, { value: new Map(), configurable: true, enumerable: false, writable: true });
    }
    return g[LAST_TRUSTED_KEY];
}
/**
 * The on-disk copy, only if it can be trusted as a separate record: a
 * regular file with one link that isn't the store itself (security review:
 * a hard link or symlink to the store would make every later store write
 * read back as "trusted"). Anything else reads as no copy.
 */
function _readTrustedCopy(file) {
    const r = readRegularFile(_trustedPath(file));
    // Only the store itself (same file) or a non-file is rejected: a hard
    // link to some other file gives nothing a direct write wouldn't.
    if (r.raw === null)
        return null;
    try {
        const s2 = fs.statSync(file);
        if (s2.ino === r.st.ino && s2.dev === r.st.dev)
            return null;
    }
    catch (_) { /* no store: nothing to alias */ }
    return r.raw;
}
function _writeTrusted(file, raw) {
    _lastTrusted().set(file, raw);
    const t = _trustedPath(file);
    try {
        // A fresh file renamed over the old entry: replaces a link, never writes through it.
        if (_readTrustedCopy(file) === raw)
            return;
        // Re-review: a directory (or anything but a file) at the record's path
        // can't be renamed over — clear it first; it isn't a record Gryphon wrote.
        clearNonFile(t);
        const tmp = `${t}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
        try {
            fs.renameSync(tmp, t);
        }
        catch (e) {
            try {
                fs.unlinkSync(tmp);
            }
            catch (_) { }
            throw e;
        }
    }
    catch (e) {
        console.warn(`[gryphon/security-settings] couldn't record the trusted copy of the security settings: ${e.message}`);
    }
}
const _tamperSinks = new Set();
/** Changes undone (or that couldn't be) outside a reply's own check. */
function onSecurityStoreTamper(fn) {
    _tamperSinks.add(fn);
    return () => { _tamperSinks.delete(fn); };
}
function _emitTamper(reverted, error, info) {
    for (const fn of _tamperSinks) {
        try {
            fn(reverted, error, info);
        }
        catch (_) { /* a sink must not break reads */ }
    }
}
let _verifying = false;
/**
 * QA P2-A: what an adopted file loosens compared with the defaults (values
 * looser than the protected default, and any confirmed program location),
 * so the "record started" notice can name what to check.
 */
function _loosenedIn(raw, file) {
    try {
        return _weakenings(_parse(raw, file, "adopt", _quiet), _empty())
            .filter((w) => w.field !== "dismissed")
            .map((w) => ({ vaultKey: w.vaultKey, hostId: w.hostId, key: w.field === "values" ? w.key : `${w.field}.${w.key}` }));
    }
    catch (_) {
        return [];
    }
}
/** True when `raw` holds any per-vault entry (an empty store needs no look). */
function _hasEntries(raw) {
    try {
        const o = JSON.parse(raw);
        return !!(o && typeof o === "object" && o.vaults && typeof o.vaults === "object" && Object.keys(o.vaults).length);
    }
    catch (_) {
        return false;
    }
}
/**
 * The content to read: `raw` itself if it is Gryphon's, else `raw` judged
 * (that exact content — never a second read) with its weakening parts
 * undone, or the content Gryphon last accepted if the undo fails.
 */
/**
 * Vaults this process serves (read or written here), shared by every
 * bundled copy in the process. Each Obsidian vault window is its own
 * process, so another window's vaults are not in this set.
 */
const SERVED_KEY = Symbol.for("gryphon.securityServedVaults");
function _served() {
    const g = process;
    if (!(g[SERVED_KEY] instanceof Set))
        Object.defineProperty(g, SERVED_KEY, { value: new Set(), configurable: true, enumerable: false, writable: true });
    return g[SERVED_KEY];
}
function _serve(scope) {
    if (scope && typeof scope.vaultKey === "string" && scope.vaultKey)
        _served().add(scope.vaultKey);
}
function _sameContent(a, b) {
    try {
        return mcpApprovals.canonicalJSON(JSON.parse(a)) === mcpApprovals.canonicalJSON(JSON.parse(b));
    }
    catch (_) {
        return false;
    }
}
/**
 * What the store should hold, per vault. A vault this process serves: what
 * this process last accepted (an agent that writes the store can write the
 * copy beside it too). Any other vault: the trusted copy, which another
 * Gryphon window updates with its own writes (review: judging another
 * window's settings against this process's memory undid them). After a
 * restart (no memory): the copy. Null: no record.
 */
function _baselineRaw(file, copyIn) {
    const mem = _lastTrusted().get(file);
    const copy = copyIn !== undefined ? copyIn : _readTrustedCopy(file);
    if (mem === undefined)
        return copy;
    if (copy === null) {
        // Re-review: the record is missing or not a plain file (deleted,
        // replaced, linked) while this window knows what it should be — put it
        // back, so a restart doesn't find "no record".
        _writeTrusted(file, mem);
        return mem;
    }
    return _othersFromCopy(mem, copy);
}
/**
 * `base` with every vault this process doesn't serve — and every top-level
 * field this version doesn't know (review: a newer window's fields were
 * stripped with a false alert) — taken from the trusted copy, which the
 * windows serving them keep current. Vaults served here keep `base`.
 */
function _othersFromCopy(base, copy) {
    // Total (review N-1): a value nested thousands of levels deep in the copy
    // overflowed the stack when re-serialised, so the turn-end check threw
    // before undoing anything and every read failed until a restart. Deep
    // values from the copy are pruned first; any failure keeps `base`.
    try {
        // Both sides pruned (review R6-1: a deep value accepted into this
        // window's record overflowed here too, so the merge was skipped and
        // another window's change was undone).
        const out = _pruneDeep(_rawObject(base));
        const c = _pruneDeep(_rawObject(copy));
        if (!out || !_isPlainObject(out.vaults) || !c)
            return base;
        const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        // Top-level fields this version doesn't know come from the copy (a newer
        // window may have written them). They are inert here — so a FUTURE
        // security-relevant field must live inside a per-vault host entry,
        // never at the top level, or a plant written to both files would stick.
        for (const k of new Set([...Object.keys(out), ...Object.keys(c)])) {
            if (KNOWN_TOP.has(k))
                continue;
            if (own(c, k))
                _setOwnKey(out, k, c[k]);
            else
                delete out[k];
        }
        const cv = _isPlainObject(c.vaults) ? c.vaults : {};
        const served = _served();
        for (const vk of new Set([...Object.keys(out.vaults), ...Object.keys(cv)])) {
            if (served.has(vk))
                continue;
            if (own(cv, vk))
                _setOwnKey(out.vaults, vk, cv[vk]);
            else
                delete out.vaults[vk];
        }
        return JSON.stringify(out, null, 2) + "\n";
    }
    catch (e) {
        console.warn("[gryphon/security-settings] couldn't merge the trusted copy; judging against this window's record:", e.message);
        return base;
    }
}
function _verifyAgainstTrusted(file, raw) {
    if (_verifying)
        return raw;
    const l = _ledger();
    const copy0 = _readTrustedCopy(file);
    // Post-push review F1: no "equals this process's last write" shortcut —
    // those bytes can be stale for another window's vaults and replayed.
    // Gryphon's own write is already the in-memory record (set by _save).
    // Security review: within a session, what this process accepted wins — an
    // agent that can write the store can write the copy beside it too. The
    // copy only stands in after a restart.
    const trusted = _baselineRaw(file, copy0);
    if (trusted !== null && (trusted === raw || _sameContent(trusted, raw))) {
        _writeTrusted(file, raw);
        return raw;
    }
    if (trusted === null) {
        // No record anywhere: first run with this version, or the record was
        // deleted while Gryphon wasn't running. Take the file as it is, and say
        // so when it holds settings worth checking.
        _writeTrusted(file, raw);
        if (_hasEntries(raw))
            _emitTamper(_loosenedIn(raw, file), null, "record-started");
        return raw;
    }
    if (!_parses(raw)) {
        // Security review: an unreadable file is never the new baseline (it
        // would read as the defaults, dropping a stricter "plan"). Keep using
        // what Gryphon last accepted and say so once.
        _reportBad(file, raw);
        return trusted;
    }
    _verifying = true;
    const seq = l.seq;
    try {
        const r = checkSecurityStoreTamper({ file, raw: trusted, seq }, raw);
        if (r.reverted.length) {
            _emitTamper(r.reverted, null);
            // Use what Gryphon just wrote — never a re-read, which could be a
            // newer foreign write nobody judged.
            const wrote = _ledger().seq > seq ? _ledger().entries[_ledger().entries.length - 1].raw : null;
            return wrote !== null ? wrote : trusted;
        }
        // Nothing weaker (a strengthening): this content is now the baseline.
        _writeTrusted(file, raw);
        return raw;
    }
    catch (e) {
        // Couldn't undo it: never use the foreign content. Reported once per
        // content (review: a stuck undo re-ran on every read, each one a notice).
        const tag = `${file}\u0000undo\u0000${_sha256(raw)}`;
        if (!_reportedBad.has(tag)) {
            _reportedBad.add(tag);
            console.error("[gryphon/security-settings] couldn't undo a change made outside Gryphon:", e);
            _emitTamper([], e);
        }
        // Review of 86d167a/452fc37: the content the undo computed, else the
        // checked baseline — never the stored or recorded content as-is.
        const safe = e && typeof e === "object" ? e.gryphonSafeContent : undefined;
        return typeof safe === "string" ? safe : trusted;
    }
    finally {
        _verifying = false;
    }
}
function _parses(raw) {
    try {
        JSON.parse(raw);
        return true;
    }
    catch (_) {
        return false;
    }
}
const _reportedBad = new Set();
function _reportBad(file, raw) {
    const tag = `${file}\u0000${raw === null ? "missing" : _sha256(raw)}`;
    if (_reportedBad.has(tag))
        return;
    _reportedBad.add(tag);
    const what = raw === null ? "was deleted or replaced by something that isn't a file" : "isn't readable";
    console.error(`[gryphon/security-settings] ${file} ${what} outside Gryphon; using the settings Gryphon last saved`);
    _emitTamper([], new Error(`the security settings file ${what}`));
}
/** The store is missing: Gryphon's last accepted content, if any (security review). */
/**
 * Record "the defaults" for a store that doesn't exist: in memory, and on
 * disk (the settings folder is created if needed, so the record survives a
 * restart). Exclusive create, so a valid record another window just wrote
 * isn't overwritten; anything else already at the path (a directory, a
 * link — not a record Gryphon wrote) is replaced.
 */
function _initEmptyRecord(file, empty) {
    _lastTrusted().set(file, empty);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(_trustedPath(file), empty, { mode: 0o600, flag: "wx" });
    }
    catch (e) {
        if (e.code !== "EEXIST") {
            console.warn(`[gryphon/security-settings] couldn't record the security settings' starting point: ${e.message}`);
            return;
        }
        if (_readTrustedCopy(file) !== null)
            return; // another window's valid record
        clearNonFile(_trustedPath(file));
        _writeTrusted(file, empty);
    }
}
function _missingStore(file, absent = false) {
    // Per vault (review): another window's changes come from the copy.
    const trusted = _baselineRaw(file);
    if (trusted === null) {
        // Re-review: only a file that truly doesn't exist is "the defaults". A
        // file that can't be READ (permissions, a Windows lock) may hold the
        // user's own settings; recording "empty" for it would strip them once
        // it becomes readable. It gets the no-record path when it can be read.
        if (!absent)
            return null;
        // Post-push review F2: no settings file and no record (a user who has
        // never changed a security setting) is a KNOWN state — the defaults —
        // not "no record". Record it, so a file that appears later (a delayed
        // write) is judged against the defaults instead of adopted.
        _initEmptyRecord(file, JSON.stringify(_empty(), null, 2) + "\n");
        return null;
    }
    if (!_hasEntries(trusted))
        return null;
    _reportBad(file, null);
    return trusted;
}
/**
 * The content a write should start from: the store as judged, or — when it
 * is missing — Gryphon's last accepted content. Security review: starting
 * from the raw file let a settings change carry an unjudged plant into
 * Gryphon's own (trusted) write.
 */
function _verifiedRaw(file) {
    const r = readRegularFile(file, { follow: true });
    if (r.raw === null)
        return _missingStore(file, r.absent);
    return _verifyAgainstTrusted(file, r.raw);
}
function _entry(store, scope) {
    const vault = Object.prototype.hasOwnProperty.call(store.vaults, scope.vaultKey) ? store.vaults[scope.vaultKey] : null;
    return vault && Object.prototype.hasOwnProperty.call(vault.hosts, scope.hostId) ? vault.hosts[scope.hostId] : null;
}
function _requireScope(scope) {
    if (!scope || !_validName(scope.vaultKey) || !_validName(scope.hostId)) {
        throw new SecurityScopeUnavailableError(!scope ? "app" : !_validName(scope.vaultKey) ? "basePath" : "hostId");
    }
    return scope;
}
/**
 * R43-8: what to write. Only the touched scopes are re-serialised from the
 * validated store; every other vault/host, any unknown top-level field and
 * (when `keepUnknown`) unknown fields inside a touched entry are carried
 * over from the file as found. A different Gryphon version (older, or one
 * that adds a field) must not wipe what this one doesn't understand — a
 * 2.10.x copy erased every confirmed CLI path this way. Reads still
 * validate everything. A file this copy can't parse is rebuilt as before.
 */
function _rawObject(raw) {
    if (raw === null)
        return null;
    try {
        const p = JSON.parse(raw);
        return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    }
    catch (_) {
        return null;
    }
}
function _isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
/**
 * Re-review: the validated values for a touched entry, MINUS keys whose raw
 * value already reads as exactly that — those keep their raw form, so a
 * longer list from a newer version (patterns this one drops when reading)
 * isn't trimmed by an unrelated write. A key the write actually changed
 * gets its new value.
 */
function _changedOnly(rawBag, validated) {
    const raw = _isPlainObject(rawBag) ? rawBag : {};
    const out = {};
    for (const [k, v] of Object.entries(validated)) {
        if (Object.prototype.hasOwnProperty.call(raw, k)) {
            const r = validateSecurityValue(k, raw[k]);
            if (r.ok && mcpApprovals.canonicalJSON(r.value) === mcpApprovals.canonicalJSON(v)) {
                _setOwnKey(out, k, raw[k]);
                continue;
            }
        }
        _setOwnKey(out, k, v);
    }
    return out;
}
function _setOwnKey(o, k, v) {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}
function _composeForWrite(priorRaw, store, touched, keepUnknown) {
    // Review R5-1: pruned, or a deeply nested planted value made every
    // settings write overflow the stack — locking the user out of their own
    // settings. A value deeper than PRUNE_DEPTH is dropped on the next write.
    const base = _pruneDeep(_rawObject(priorRaw));
    if (!base || !_isPlainObject(base.vaults))
        return store;
    const out = JSON.parse(JSON.stringify(base));
    if (typeof out.version !== "number")
        out.version = STORE_VERSION;
    // Carried over: keys this version doesn't know, AND known keys whose raw
    // value it can't read (R44 F1 — e.g. a future version's longer pattern
    // list); the validated values this write produces then take precedence.
    const unknownOnly = (bag, known, bagName) => Object.fromEntries(Object.entries(_isPlainObject(bag) ? bag : {}).filter(([k, v]) => !known(k) || !_cleanKnown(bagName, k, v)));
    for (const [vk, hostId] of touched) {
        if (!_isPlainObject(out.vaults[vk]))
            out.vaults[vk] = { hosts: {} };
        if (!_isPlainObject(out.vaults[vk].hosts))
            out.vaults[vk].hosts = {};
        const e = _entry(store, { vaultKey: vk, hostId });
        if (!e) {
            delete out.vaults[vk].hosts[hostId];
            continue;
        }
        const rawE = keepUnknown && _isPlainObject(out.vaults[vk].hosts[hostId]) ? out.vaults[vk].hosts[hostId] : {};
        out.vaults[vk].hosts[hostId] = {
            ...rawE,
            values: { ...unknownOnly(rawE.values, isWeakeningKey, "values"), ..._changedOnly(rawE.values, e.values) },
            setAt: e.setAt,
            dismissed: { ...unknownOnly(rawE.dismissed, (k) => isWeakeningKey(k) || isExecutableKey(k), "dismissed"), ...e.dismissed },
            paths: { ...unknownOnly(rawE.paths, isExecutableKey, "paths"), ...e.paths },
        };
    }
    return out;
}
/** Re-read right before writing; change only this scope's entry. */
function _update(scope, file, fn) {
    _serve(scope);
    const priorRaw = _verifiedRaw(file);
    // No "newer version, refuse to write" guard (commit review of 0d516c2):
    // an assistant that planted a bigger `version` would lock the user out of
    // their own security settings. Unknown fields are preserved instead, and
    // an INCOMPATIBLE future format must use a new file name, never an
    // in-place version bump.
    const store = priorRaw === null ? _empty() : _parse(priorRaw, file, "update");
    if (!store.vaults[scope.vaultKey])
        store.vaults[scope.vaultKey] = { hosts: Object.create(null) };
    const hosts = store.vaults[scope.vaultKey].hosts;
    if (!hosts[scope.hostId])
        hosts[scope.hostId] = { values: {}, setAt: "", dismissed: {}, paths: {} };
    fn(hosts[scope.hostId]);
    _save(_composeForWrite(priorRaw, store, [[scope.vaultKey, scope.hostId]], true), file, priorRaw);
}
// ── public API ─────────────────────────────────────────────────────────
/** This scope's confirmed values (validated). */
function readMachineSecuritySettings(scope, opts = {}) {
    _serve(scope);
    const entry = _entry(_load(opts.file || securitySettingsFilePath()), _requireScope(scope));
    return entry ? { ...entry.values } : {};
}
/**
 * Store a value for this scope. Call ONLY from an explicit user gesture on
 * this machine. Validates; throws on an unknown key or an invalid value.
 * Writes in both directions: turning protection back on is stored too, so
 * a stale weaker value can't keep winning.
 */
function setMachineSecuritySetting(scope, key, value, opts = {}) {
    _requireScope(scope);
    const v = validateSecurityValue(key, value);
    if (!v.ok)
        throw new Error(`security-settings: ${v.reason}`);
    _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
        entry.values[key] = v.value;
        entry.setAt = (opts.now || new Date()).toISOString();
        delete entry.dismissed[key];
    });
}
/** "Keep protections on": stay quiet until data.json brings a different value. */
function dismissVaultSecuritySuggestion(scope, key, value, opts = {}) {
    _requireScope(scope);
    if (isExecutableKey(key)) {
        const configured = _configuredPath(value);
        if (!configured)
            throw new Error(`security-settings: ${key} must be a path`);
        _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
            entry.dismissed[key] = hashValue(configured);
        });
        return;
    }
    if (!isWeakeningKey(key))
        throw new Error(`security-settings: unknown key ${JSON.stringify(key)}`);
    // Hash the normalized value: that's what effectiveSecuritySettings compares.
    const v = validateSecurityValue(key, value);
    if (!v.ok)
        throw new Error(`security-settings: ${v.reason}`);
    _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
        entry.dismissed[key] = hashValue(v.value);
    });
}
/**
 * Validate a consumer's `securityOverrides`. Unknown keys and invalid values
 * are logged and ignored (they resolve as if absent).
 */
function sanitizeSecurityOverrides(overrides, label = "securityOverrides") {
    const out = {};
    if (overrides === undefined || overrides === null)
        return out;
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
        console.error(`[gryphon] ${label} must be an object; ignored`);
        return out;
    }
    for (const [k, v] of Object.entries(overrides)) {
        // Issue #30: `paths` carries code-set CLI binaries — see sanitizeCliPathOverrides.
        if (k === "paths")
            continue;
        const ok = validateSecurityValue(k, v);
        if (ok.ok)
            out[k] = ok.value;
        else
            console.error(`[gryphon] ${label}: ignored ${JSON.stringify(k)} (${ok.reason})`);
    }
    return out;
}
function _sameValue(a, b) {
    return mcpApprovals.canonicalJSON(a) === mcpApprovals.canonicalJSON(b);
}
function _freezeDeep(o) {
    if (o && typeof o === "object") {
        for (const v of Object.values(o))
            _freezeDeep(v);
        Object.freeze(o);
    }
    return o;
}
function _stringList(v) {
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
function effectiveSecuritySettings(settings, scope, overrides, opts = {}) {
    const raw = settings && typeof settings === "object" ? settings : {};
    const ov = sanitizeSecurityOverrides(overrides);
    let machine = {};
    let dismissed = {};
    let machinePaths = {};
    if (scope) {
        _serve(scope);
        const entry = _entry(_load(opts.file || securitySettingsFilePath()), scope);
        if (entry) {
            machine = entry.values;
            dismissed = entry.dismissed;
            machinePaths = entry.paths || {};
        }
    }
    const out = {};
    const source = {};
    const unconfirmed = [];
    for (const key of WEAKENING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(ov, key)) {
            out[key] = ov[key];
            source[key] = "override";
        }
        else if (Object.prototype.hasOwnProperty.call(machine, key)) {
            out[key] = machine[key];
            source[key] = "machine";
        }
        else {
            out[key] = DEFAULTS[key];
            source[key] = "default";
        }
        out[key] = Array.isArray(out[key]) ? [...out[key]] : out[key];
        if (!scope || source[key] === "override")
            continue;
        // The data.json comparison: a suggestion, never an input.
        const fromFile = validateSecurityValue(key, raw[key]);
        if (!fromFile.ok || !isWeakening(key, fromFile.value))
            continue;
        if (_sameValue(fromFile.value, out[key]))
            continue;
        if (dismissed[key] === hashValue(fromFile.value))
            continue;
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
        ? _unconfirmedPaths(raw, machinePaths, dismissed, sanitizeCliPathOverrides(overrides && overrides.paths), opts.detect)
        : [];
    return _freezeDeep(out);
}
function _unconfirmedPaths(raw, machinePaths, dismissed, ovPaths, detect) {
    const out = [];
    for (const [kind, key] of Object.entries(CLI_PATH_KEY_BY_KIND)) {
        const fromFile = _configuredPath(raw[key]); // cli-path-read-ok: the migration comparator
        if (!fromFile || ovPaths[key])
            continue;
        if (machinePaths[key] === fromFile)
            continue;
        if (dismissed[key] === hashValue(fromFile))
            continue;
        // Equal to what detection finds → nothing to confirm (most users).
        const detected = _detect(kind, detect);
        if (detected && _samePath(detected, fromFile))
            continue;
        out.push(key);
    }
    return out;
}
/** Just the nine weakening values of a snapshot (for comparisons / logs). */
function securityValuesOf(sec) {
    const out = {};
    for (const k of WEAKENING_KEYS)
        out[k] = sec ? sec[k] : undefined;
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
function securityInputsOf(holder) {
    if (holder && holder.security && typeof holder.security === "object")
        return holder.security;
    if (holder && holder.settings && typeof holder.settings === "object")
        return holder.settings;
    const plugin = holder && holder.plugin;
    if (!plugin)
        return {};
    if (!_warnedNoSnapshot) {
        _warnedNoSnapshot = true;
        console.warn("[gryphon/security-settings] a protection check got no security snapshot; using the protected " +
            "defaults (the host's settings file is never an enforcement input). Pass `security` " +
            "(effectiveSecuritySettings) or an explicit `settings` object.");
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
/** Thrown by setMachineCliPath only; resolveCliPath never throws. */
const CLI_PATH_PRODUCT = {
    claudePath: "Claude Code",
    codexPath: "Codex",
    geminiCliPath: "Gemini CLI",
    antigravityPath: "Antigravity",
};
class CliPathRejectedError extends Error {
    key;
    value;
    reason;
    constructor(key, value, reason) {
        // R43-20: user-facing — product names, never the internal setting key.
        super(`Gryphon can't use ${JSON.stringify(value)} as the ${CLI_PATH_PRODUCT[key] || "program"} location: ${CLI_PATH_REASON_TEXT[reason]}`);
        this.name = "CliPathRejectedError";
        this.key = key;
        this.value = value;
        this.reason = reason;
    }
}
const CLI_PATH_REASON_TEXT = {
    "relative": "use the full path (starting with / or a drive letter)",
    "missing": "no file exists there",
    "not-a-file": "that's a folder, not a program",
    "not-executable": "that file isn't executable",
    "inside-vault": "it's inside this vault, and files in a vault can change when the vault syncs",
    "too-old": "that version is too old",
};
const WIN_EXEC_RE = /\.(exe|cmd|bat|ps1)$/i;
function _isAbsoluteAnywhere(p) {
    return path.isAbsolute(p) || path.win32.isAbsolute(p);
}
/** A configured path as stored: trimmed, `~` expanded. "" when unusable. */
function _configuredPath(value) {
    if (typeof value !== "string")
        return "";
    const v = value.trim();
    if (!v)
        return "";
    if (/^~(?=$|[\\/])/.test(v))
        return path.join(os.homedir(), v.slice(1));
    return v;
}
function _norm(p) {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
/** `p` is `root` or inside it. Case-insensitive: a false positive refuses, never allows. */
function _inside(p, root) {
    const a = _norm(p);
    const r = _norm(root);
    return !!r && (a === r || a.startsWith(r + "/"));
}
function _vaultRoots(vaultRoot) {
    if (!vaultRoot)
        return [];
    const roots = [path.resolve(vaultRoot)];
    try {
        roots.push(fs.realpathSync(vaultRoot));
    }
    catch (_) { /* gone */ }
    return roots;
}
function _samePath(a, b) {
    const real = (p) => { try {
        return fs.realpathSync(p);
    }
    catch (_) {
        return path.resolve(p);
    } };
    return _norm(real(a)) === _norm(real(b));
}
/**
 * Validate a configured CLI path. Returns the configured path and its
 * realpath (the thing to spawn), or why it can't be used. The configured
 * path AND its realpath must both be outside the vault: an in-vault symlink
 * to an outside binary could be re-pointed by sync.
 */
function validateCliPath(value, vaultRoot, platform = process.platform) {
    const configured = _configuredPath(value);
    if (!configured || !_isAbsoluteAnywhere(configured))
        return { ok: false, reason: "relative" };
    const roots = _vaultRoots(vaultRoot);
    // R43-6: by string AND by file identity, so another name for the vault
    // (a symlinked folder, a macOS firmlink, a Windows UNC/8.3 spelling)
    // can't pass for "outside".
    const inVault = (p) => roots.some((r) => _inside(p, r)) || isWithinByIdentity(p, roots);
    if (inVault(configured))
        return { ok: false, reason: "inside-vault" };
    let real;
    try {
        real = fs.realpathSync(configured);
    }
    catch (_) {
        return { ok: false, reason: "missing" };
    }
    if (inVault(real))
        return { ok: false, reason: "inside-vault" };
    let st;
    try {
        st = fs.statSync(real);
    }
    catch (_) {
        return { ok: false, reason: "missing" };
    }
    if (!st.isFile())
        return { ok: false, reason: "not-a-file" };
    if (platform === "win32") {
        if (!WIN_EXEC_RE.test(real))
            return { ok: false, reason: "not-executable" };
    }
    else {
        try {
            fs.accessSync(real, fs.constants.X_OK);
        }
        catch (_) {
            return { ok: false, reason: "not-executable" };
        }
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
function setMachineCliPath(scope, key, value, opts = {}) {
    _requireScope(scope);
    if (!isExecutableKey(key))
        throw new Error(`security-settings: unknown CLI path key ${JSON.stringify(key)}`);
    const cleared = value === null || value === undefined || (typeof value === "string" && !value.trim());
    let configured = "";
    if (!cleared) {
        const v = validateCliPath(value, scope.vaultKey);
        if (!v.ok)
            throw new CliPathRejectedError(key, String(value), v.reason);
        configured = v.configured;
    }
    _update(scope, opts.file || securitySettingsFilePath(), (entry) => {
        if (!entry.paths)
            entry.paths = {};
        if (cleared)
            delete entry.paths[key];
        else
            entry.paths[key] = configured;
        entry.setAt = new Date().toISOString();
        delete entry.dismissed[key];
    });
}
/** Validate an embedder's code-set `securityOverrides.paths`. */
function sanitizeCliPathOverrides(paths) {
    const out = {};
    if (!paths || typeof paths !== "object" || Array.isArray(paths))
        return out;
    for (const [k, v] of Object.entries(paths)) {
        const p = _configuredPath(v);
        if (isExecutableKey(k) && p)
            out[k] = p;
        else
            console.error(`[gryphon] securityOverrides.paths: ignored ${JSON.stringify(k)}`);
    }
    return out;
}
/**
 * Detection is provider-runtime's find*Binary — the exact functions every
 * caller used before, so an embedder's fallback can't diverge from the chat
 * view's. Looked up through the module object on each call so a patched
 * finder (tests) applies. A caller may inject its own `detect`.
 */
const FINDER_BY_KIND = {
    "claude-code": "findClaudeBinary",
    "codex-cli": "findCodexBinary",
    "gemini-cli": "findGeminiBinary",
    "antigravity-cli": "findAntigravityBinary",
};
function _runtimeUtils() { return require("../../provider-runtime/dist/utils"); }
function _detect(kind, detect) {
    try {
        if (typeof detect === "function")
            return detect(kind) || null;
        const fn = _runtimeUtils()[FINDER_BY_KIND[kind]];
        return typeof fn === "function" ? fn() || null : null;
    }
    catch (e) {
        console.warn(`[gryphon/security-settings] detecting ${kind} failed: ${e.message}`);
        return null;
    }
}
/** The version floor check — runs ONLY on an already-validated realpath. */
function _versionOf(kind, real) {
    try {
        const u = _runtimeUtils();
        const label = { "claude-code": "claude", "codex-cli": "codex", "gemini-cli": "gemini", "antigravity-cli": "agy" }[kind];
        const v = u.probeVersion(real, undefined, u._versionSignatureFor(label));
        // The runtime's floors are permissive today ("0.0.0"); a too-old
        // verdict comes from resolveCliBinary's typed failure.
        if (!v)
            return { version: null, tooOld: false };
        const r = u.resolveCliBinary(kind, real);
        const tooOld = !!(r && !r.ok && r.error === "too-old");
        return { version: v, tooOld };
    }
    catch (_) {
        return { version: null, tooOld: false };
    }
}
const _reportedRejections = new Set();
let _warnedNoHostId = false;
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
function resolveCliPath(kind, ctx = {}) {
    const key = CLI_PATH_KEY_BY_KIND[kind];
    if (!key)
        return { path: null, source: null, version: null, unavailable: "not-found" };
    const described = describeSecurityScope({ app: ctx.app, hostPlugin: ctx.hostPlugin, hostId: ctx.hostId });
    const scope = described.scope;
    _serve(scope);
    const vaultRoot = scope ? scope.vaultKey : _basePathOf(ctx.app || (ctx.hostPlugin && ctx.hostPlugin.app));
    let rejected;
    let tooOldSeen = false;
    const reject = (value, reason) => {
        if (!rejected)
            rejected = { key, value, reason };
        const tag = `${key}\u0000${value}\u0000${reason}`;
        if (!_reportedRejections.has(tag)) {
            _reportedRejections.add(tag);
            console.warn(`[gryphon] not using ${value} for ${key}: ${CLI_PATH_REASON_TEXT[reason]}. Falling back.`);
        }
    };
    const tryCandidate = (value, source) => {
        const v = validateCliPath(value, vaultRoot);
        if (!v.ok) {
            reject(value, v.reason);
            return null;
        }
        const ver = _versionOf(kind, v.real);
        if (ver.tooOld) {
            tooOldSeen = true;
            reject(value, "too-old");
            return null;
        }
        const out = { path: v.real, source, version: ver.version ? ver.version.join(".") : null };
        if (rejected)
            out.rejected = rejected;
        return out;
    };
    const ov = sanitizeCliPathOverrides(ctx.overrides && ctx.overrides.paths);
    if (ov[key]) {
        const r = tryCandidate(ov[key], "override");
        if (r)
            return r;
    }
    if (scope) {
        let stored;
        try {
            const entry = _entry(_load(securitySettingsFilePath()), scope);
            stored = entry && entry.paths ? entry.paths[key] : undefined;
        }
        catch (_) {
            stored = undefined;
        }
        if (stored) {
            const r = tryCandidate(stored, "machine");
            if (r)
                return r;
        }
    }
    else if (described.missing === "hostId" && !_warnedNoHostId) {
        _warnedNoHostId = true;
        console.warn("[gryphon] no securityHostId: CLI paths confirmed on this machine are not used; set securityHostId in the view options.");
    }
    const detected = _detect(kind, ctx.detect);
    if (detected) {
        const r = tryCandidate(detected, "detected");
        if (r)
            return r;
    }
    const out = { path: null, source: null, version: null, unavailable: tooOldSeen ? "too-old" : "not-found" };
    if (rejected)
        out.rejected = rejected;
    return out;
}
function _basePathOf(app) {
    try {
        const a = app && app.vault && app.vault.adapter;
        const bp = a && typeof a.getBasePath === "function" ? a.getBasePath() : a && a.basePath;
        return typeof bp === "string" && bp ? bp : null;
    }
    catch (_) {
        return null;
    }
}
function _readRaw(file) {
    return readRegularFile(file, { follow: true }).raw;
}
/** Turn start: remember the store's content and the ledger position. */
function snapshotSecurityStore(opts = {}) {
    const file = opts.file || securitySettingsFilePath();
    // Security review: the turn's reference is the CHECKED content (or, if
    // the file is missing or unreadable, what Gryphon last accepted) — never
    // raw bytes, or a plant that reached them would be restored by the
    // turn-end undo and recorded as Gryphon's own.
    return { file, raw: _verifiedRaw(file), seq: _ledger().seq };
}
const _quiet = () => { };
const PERM_STRENGTH = { plan: 3, default: 2, acceptEdits: 1, bypassPermissions: 0 };
/** a is looser (removes protection) than b. Both are validated values. */
function _looser(key, a, b) {
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
            return a.some((p) => !b.includes(p));
    }
}
function _emptyEntry() { return { values: {}, setAt: "", dismissed: {}, paths: {} }; }
/** Every entry, for any vault and host, that is weaker in `cand` than in `base`. */
function _weakenings(cand, base) {
    const out = [];
    for (const [vk, vault] of Object.entries(cand.vaults)) {
        for (const [hostId, entry] of Object.entries(vault.hosts)) {
            const b = _entry(base, { vaultKey: vk, hostId }) || _emptyEntry();
            for (const key of WEAKENING_KEYS) {
                const av = Object.prototype.hasOwnProperty.call(entry.values, key) ? entry.values[key] : DEFAULTS[key];
                const bHas = Object.prototype.hasOwnProperty.call(b.values, key);
                const bv = bHas ? b.values[key] : DEFAULTS[key];
                if (_looser(key, av, bv))
                    out.push({ vaultKey: vk, hostId, field: "values", key, baseHas: bHas, baseVal: b.values[key], candVal: entry.values[key] });
            }
            for (const field of ["paths", "dismissed"]) {
                const cur = entry[field] || {};
                const was = b[field] || {};
                for (const key of Object.keys(cur)) {
                    if (was[key] === cur[key])
                        continue;
                    out.push({ vaultKey: vk, hostId, field, key, baseHas: !!was[key], baseVal: was[key], candVal: cur[key] });
                }
            }
        }
    }
    // QA P3-1: an entry DELETED since `base` reads as the defaults — which
    // are not always the strictest (permission mode "plan" is stricter than
    // the default). Compare it as an empty entry so that loss is seen too.
    for (const [vk, vault] of Object.entries(base.vaults)) {
        for (const [hostId, b] of Object.entries(vault.hosts)) {
            if (_entry(cand, { vaultKey: vk, hostId }))
                continue;
            for (const key of WEAKENING_KEYS) {
                if (!Object.prototype.hasOwnProperty.call(b.values, key))
                    continue;
                if (_looser(key, DEFAULTS[key], b.values[key])) {
                    out.push({ vaultKey: vk, hostId, field: "values", key, baseHas: true, baseVal: b.values[key], candVal: undefined });
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
/**
 * R43-8 review: Gryphon's writes now carry fields this version doesn't know
 * forward untouched — so the turn-end check must police them too, or a
 * field planted mid-reply (say, a weakening key a FUTURE Gryphon reads)
 * would persist. Gryphon itself never changes unknown fields, so any change
 * to them during a reply is foreign: they're restored to the turn start.
 */
const KNOWN_TOP = new Set(["version", "vaults"]);
const KNOWN_ENTRY = new Set(["values", "setAt", "dismissed", "paths"]);
const BAG_KNOWN = {
    values: (k) => isWeakeningKey(k),
    dismissed: (k) => isWeakeningKey(k) || isExecutableKey(k),
    paths: (k) => isExecutableKey(k),
};
/**
 * A known key's raw value that this version reads as-is. Anything else — a
 * value it rejects or normalises — is opaque to it but may mean something
 * to another Gryphon version, so it's policed like an unknown field.
 */
function _cleanKnown(bag, k, v) {
    if (bag === "values") {
        const r = validateSecurityValue(k, v);
        return r.ok && mcpApprovals.canonicalJSON(r.value) === mcpApprovals.canonicalJSON(v);
    }
    if (bag === "dismissed")
        return typeof v === "string" && HASH_RE.test(v);
    if (bag === "paths")
        return typeof v === "string" && !!v && _isAbsoluteAnywhere(v);
    return true;
}
/**
 * The unknown / unclean parts of a store, flattened under STRUCTURED keys
 * (JSON arrays — R44 E7-3: a string key like "values.X" must never be
 * confused with the bag key values → X, nor split on separators a vault
 * key may contain):
 *   ["t", k]                 unknown top-level field
 *   ["e", vk, hid, k]        unknown entry field
 *   ["b", vk, hid, bag, k]   unknown or unclean key inside a bag
 *   ["B", vk, hid, bag]      a bag that isn't an object
 */
/**
 * Re-review: a value nested deeper than this (a planted `[[[…]]]` thousands
 * of levels deep) overflowed the recursive canonical compare and crashed
 * the turn-end check before it could revert anything. Such values are
 * never this version's data: they're left out of the expected parts, so
 * the restore removes them (fails toward protection).
 */
const MAX_UNKNOWN_DEPTH = 64;
const TOO_LARGE = Object.freeze({ "\u0000gryphon-too-large": true });
function _shallowEnough(v) {
    const stack = [[v, 0]];
    let seen = 0;
    while (stack.length) {
        const [x, d] = stack.pop();
        if (d > MAX_UNKNOWN_DEPTH || ++seen > 100000)
            return false;
        if (x && typeof x === "object")
            for (const c of Object.values(x))
                stack.push([c, d + 1]);
    }
    return true;
}
/**
 * A copy of the parsed store with every value nested deeper than
 * PRUNE_DEPTH removed, built iteratively (no recursion to overflow). The
 * store's own data is ~7 levels deep; anything far deeper is a plant.
 */
const PRUNE_DEPTH = 32;
function _pruneDeep(obj) {
    if (!obj)
        return obj;
    const stack = [[obj, 0]];
    while (stack.length) {
        const [node, d] = stack.pop();
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (!v || typeof v !== "object")
                continue;
            if (d + 1 >= PRUNE_DEPTH)
                delete node[k];
            else
                stack.push([v, d + 1]);
        }
    }
    return obj;
}
function _unknownFlat(obj) {
    const flat = new Map();
    // Commit review of 9cbc11e: an oversized value must still COUNT (else a
    // plant hides from the drift check) — it's recorded as a marker, never
    // compared deeply and never written back (the restore drops it).
    const m = { set: (k, v) => { flat.set(k, _shallowEnough(v) ? v : TOO_LARGE); } };
    if (!obj)
        return flat;
    for (const [k, v] of Object.entries(obj))
        if (!KNOWN_TOP.has(k))
            m.set(JSON.stringify(["t", k]), v);
    if (!_isPlainObject(obj.vaults))
        return flat;
    for (const [vk, vault] of Object.entries(obj.vaults)) {
        if (!_isPlainObject(vault) || !_isPlainObject(vault.hosts))
            continue;
        for (const [hid, e] of Object.entries(vault.hosts)) {
            if (!_isPlainObject(e))
                continue;
            for (const [k, v] of Object.entries(e))
                if (!KNOWN_ENTRY.has(k))
                    m.set(JSON.stringify(["e", vk, hid, k]), v);
            for (const bag of Object.keys(BAG_KNOWN)) {
                if (e[bag] === undefined)
                    continue;
                if (!_isPlainObject(e[bag])) {
                    m.set(JSON.stringify(["B", vk, hid, bag]), e[bag]);
                    continue;
                }
                for (const [k, v] of Object.entries(e[bag])) {
                    if (!BAG_KNOWN[bag](k) || !_cleanKnown(bag, k, v))
                        m.set(JSON.stringify(["b", vk, hid, bag, k]), v);
                }
            }
        }
    }
    return flat;
}
function _flatCanon(m) {
    return mcpApprovals.canonicalJSON([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
/** Own-property assignment: a key such as "__proto__" stays a plain key. */
function _setOwn(o, k, v) {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}
/**
 * The unknown/unclean parts the file SHOULD hold at turn end: the turn
 * start's, updated by every change Gryphon's own writes made to them this
 * turn (the ledger). A key Gryphon rewrote — e.g. the user replacing an
 * unclean list in Settings mid-reply — is credited to Gryphon, never put
 * back (#33 R43-8 review 3). Everything else is foreign.
 */
function _expectedUnknown(startRaw, own) {
    const exp = _unknownFlat(_rawObject(startRaw));
    for (const w of own) {
        const before = _unknownFlat(_rawObject(w.priorRaw));
        const after = _unknownFlat(_rawObject(w.raw));
        for (const k of new Set([...before.keys(), ...after.keys()])) {
            // Presence first: canonicalJSON(null) and canonicalJSON(undefined) agree.
            if (before.has(k) === after.has(k) && mcpApprovals.canonicalJSON(before.get(k)) === mcpApprovals.canonicalJSON(after.get(k)))
                continue;
            if (after.has(k))
                exp.set(k, after.get(k));
            else
                exp.delete(k);
        }
    }
    return exp;
}
/**
 * Write the unknown-field restore, only when it changes something, then
 * confirm it took. Returns whether anything was undone; throws when the
 * restore didn't hold (the caller shows "couldn't undo", never "undid").
 */
/** Attach the content an undo computed to the error its failed save threw. */
function _attachSafe(e, obj) {
    try {
        if (e && typeof e === "object")
            e.gryphonSafeContent = JSON.stringify(obj, null, 2) + "\n";
    }
    catch (_) { /* unserialisable: callers fall back to Gryphon's own record */ }
}
function _applyUnknownRestore(nowSafe, expected, file, priorRaw) {
    const current = _rawObject(nowSafe);
    const restored = _restoreUnknown(current, expected);
    // Unchanged only if the file itself needs nothing (pruning counts as a change).
    if (current && nowSafe === priorRaw && mcpApprovals.canonicalJSON(restored) === mcpApprovals.canonicalJSON(current))
        return false;
    try {
        _save(restored, file, priorRaw);
    }
    catch (e) {
        _attachSafe(e, restored);
        throw e;
    }
    const writtenBack = new Map([...expected].filter(([, v]) => v !== TOO_LARGE));
    if (_flatCanon(_unknownFlat(_rawObject(_readRaw(file)))) !== _flatCanon(writtenBack)) {
        throw new Error("unrecognised settings changed during the reply couldn't be put back");
    }
    console.warn("[gryphon/security-settings] undid unrecognised fields added to Gryphon's security settings during a reply");
    return true;
}
/**
 * `out` with every unknown/unclean part set to `expected`. Containers the
 * expected parts live in are recreated when they were deleted (R44 DP-2) —
 * a deleted entry that held only such fields comes back.
 */
function _restoreUnknown(out, expected) {
    const res = _isPlainObject(out) ? JSON.parse(JSON.stringify(out)) : { version: STORE_VERSION, vaults: {} };
    for (const k of Object.keys(res))
        if (!KNOWN_TOP.has(k))
            delete res[k];
    if (!_isPlainObject(res.vaults))
        res.vaults = {};
    for (const vault of Object.values(res.vaults)) {
        if (!_isPlainObject(vault) || !_isPlainObject(vault.hosts))
            continue;
        for (const e of Object.values(vault.hosts)) {
            if (!_isPlainObject(e))
                continue;
            for (const k of Object.keys(e))
                if (!KNOWN_ENTRY.has(k))
                    delete e[k];
            for (const bag of Object.keys(BAG_KNOWN)) {
                if (e[bag] !== undefined && !_isPlainObject(e[bag])) {
                    delete e[bag];
                    continue;
                }
                if (_isPlainObject(e[bag])) {
                    for (const k of Object.keys(e[bag]))
                        if (!BAG_KNOWN[bag](k) || !_cleanKnown(bag, k, e[bag][k]))
                            delete e[bag][k];
                }
            }
        }
    }
    // Commit review of a1a8009: keys come from the file, so every container
    // lookup is OWN-property only — res.vaults["__proto__"] must never reach
    // Object.prototype (writing .hosts there would pollute every object).
    const ownObj = (o, k) => {
        if (!Object.prototype.hasOwnProperty.call(o, k) || !_isPlainObject(o[k]))
            _setOwn(o, k, {});
        return o[k];
    };
    const entryOf = (vk, hid) => {
        const vault = ownObj(res.vaults, vk);
        const hosts = ownObj(vault, "hosts");
        return ownObj(hosts, hid);
    };
    for (const [key, v] of expected) {
        if (v === TOO_LARGE)
            continue; // never written back
        const parts = JSON.parse(key);
        if (parts[0] === "t")
            _setOwn(res, parts[1], v);
        else if (parts[0] === "e")
            _setOwn(entryOf(parts[1], parts[2]), parts[3], v);
        else if (parts[0] === "B")
            _setOwn(entryOf(parts[1], parts[2]), parts[3], v);
        else if (parts[0] === "b") {
            _setOwn(ownObj(entryOf(parts[1], parts[2]), parts[3]), parts[4], v);
        }
    }
    return res;
}
function checkSecurityStoreTamper(before, judged) {
    const file = before.file;
    // Review of 80f136f: no store at the turn's start (a user who never saved a
    // setting) is the empty store — merge other windows' vaults into that too.
    if (judged === undefined && before.raw === null && _readTrustedCopy(file) !== null && _readRaw(file) !== null) {
        before = { ...before, raw: JSON.stringify(_empty(), null, 2) + "\n" };
    }
    if (judged === undefined && typeof before.raw === "string") {
        // Turn end (review): vaults another window serves are judged against
        // the trusted copy that window keeps current, not this turn's start —
        // or a change the user made there during this reply is undone here.
        const copy = _readTrustedCopy(file);
        if (copy !== null)
            before = { ...before, raw: _othersFromCopy(before.raw, copy) };
    }
    // Issue #32 review: a caller that will USE some content passes exactly
    // that content, so what is judged is what is used (no second read).
    const now = judged !== undefined ? judged : _readRaw(file);
    if (now === before.raw)
        return { changed: false, reverted: [] };
    const parse = (raw) => (raw === null ? _empty() : _parse(raw, file, "tamper", _quiet));
    const parseable = (raw) => { if (raw === null)
        return true; try {
        JSON.parse(raw);
        return true;
    }
    catch (_) {
        return false;
    } };
    // Foreign changes: each (found, knownBefore) pair where they differ,
    // tagged with the index of the first Gryphon write that came after it.
    const mine = _ledger().entries.filter((e) => e.seq > before.seq);
    const foreign = [];
    let known = before.raw;
    mine.forEach((e, i) => {
        if (e.priorRaw !== known && parseable(e.priorRaw)) {
            for (const w of _weakenings(parse(e.priorRaw), parse(known)))
                foreign.push({ ...w, stage: i });
        }
        known = e.raw;
    });
    if (now === null || !parseable(now))
        return { changed: true, reverted: [] };
    // Re-review: a planted value thousands of levels deep must not crash the
    // check before it reverts anything. Everything below works from a copy
    // with such values pruned; `now` stays the ledger's prior.
    const nowObj = _pruneDeep(_rawObject(now));
    const nowSafe = nowObj ? JSON.stringify(nowObj) : now;
    if (now !== known)
        for (const w of _weakenings(parse(now), parse(known)))
            foreign.push({ ...w, stage: mine.length });
    // The unknown-field pass must never block known reverts (re-review).
    let expectedUnknown = new Map();
    let unknownDrift = false;
    try {
        expectedUnknown = _expectedUnknown(before.raw, mine);
        unknownDrift = _flatCanon(_unknownFlat(_rawObject(nowSafe))) !== _flatCanon(expectedUnknown);
    }
    catch (e) {
        console.error("[gryphon/security-settings] couldn't compare unrecognised settings:", e);
        unknownDrift = true;
    }
    if (!foreign.length) {
        if (!unknownDrift)
            return { changed: true, reverted: [] };
        if (!_applyUnknownRestore(nowSafe, expectedUnknown, file, now))
            return { changed: true, reverted: [] };
        return { changed: true, reverted: [{ vaultKey: "", hostId: "", key: "unrecognised settings" }] };
    }
    // What each of Gryphon's own writes changed, judged against the content
    // it was based on — never against the result, which may carry a foreign
    // change forward (a Settings list write re-saves the whole list).
    const ownChange = mine.map((e) => ({ prior: parse(e.priorRaw), next: parse(e.raw) }));
    const field = (st, w) => {
        const en = _entry(st, { vaultKey: w.vaultKey, hostId: w.hostId });
        return en ? (en[w.field] || {})[w.key] : undefined;
    };
    const same = (a, b) => mcpApprovals.canonicalJSON(a) === mcpApprovals.canonicalJSON(b);
    // Resolve each (vault, host, field, key) ONCE, back to a trusted value:
    // the latest value Gryphon itself set (its own change, judged against the
    // content it read), else the turn-start value — never a per-stage base,
    // which may be content a foreign write carried forward.
    const start0 = parse(before.raw);
    const groups = new Map();
    for (const w of foreign) {
        const tag = `${w.vaultKey}\u0000${w.hostId}\u0000${w.field}\u0000${w.key}`;
        if (!groups.has(tag))
            groups.set(tag, []);
        groups.get(tag).push(w);
    }
    const after = parse(now);
    const reverted = [];
    for (const ws of groups.values()) {
        const w0 = ws[0];
        let entry = _entry(after, { vaultKey: w0.vaultKey, hostId: w0.hostId });
        if (!entry) {
            // QA P3-1: the entry was deleted — recreate it to put the value back.
            if (!Object.prototype.hasOwnProperty.call(after.vaults, w0.vaultKey))
                after.vaults[w0.vaultKey] = { hosts: Object.create(null) };
            after.vaults[w0.vaultKey].hosts[w0.hostId] = _emptyEntry();
            entry = _entry(after, { vaultKey: w0.vaultKey, hostId: w0.hostId });
        }
        const bag = entry[w0.field] || (entry[w0.field] = {});
        const startEntry = _entry(start0, { vaultKey: w0.vaultKey, hostId: w0.hostId });
        const startBag = startEntry ? startEntry[w0.field] || {} : {};
        const isList = w0.field === "values" && Array.isArray(DEFAULTS[w0.key]);
        let changed = false;
        if (isList) {
            // Remove every item a foreign write added. Gryphon only gets credit
            // for an item no foreign content ever held (fails toward protection).
            const foreignHeld = new Set();
            const foreignAdded = new Set();
            for (const w of ws) {
                const base = Array.isArray(w.baseVal) ? w.baseVal : [];
                for (const x of (Array.isArray(w.candVal) ? w.candVal : [])) {
                    foreignHeld.add(x);
                    if (!base.includes(x))
                        foreignAdded.add(x);
                }
            }
            const credited = new Set();
            for (const c of ownChange) {
                const p0 = field(c.prior, w0) || [];
                for (const x of (field(c.next, w0) || []))
                    if (!p0.includes(x) && !foreignHeld.has(x))
                        credited.add(x);
            }
            const cur = Array.isArray(bag[w0.key]) ? bag[w0.key] : [];
            const kept = cur.filter((x) => !foreignAdded.has(x) || credited.has(x));
            if (kept.length !== cur.length) {
                changed = true;
                if (kept.length || Object.prototype.hasOwnProperty.call(startBag, w0.key))
                    bag[w0.key] = kept;
                else
                    delete bag[w0.key];
            }
        }
        else {
            // The latest Gryphon write that set this key, if any.
            let lastSet = -1;
            ownChange.forEach((c, i) => { if (!same(field(c.prior, w0), field(c.next, w0)))
                lastSet = i; });
            // Foreign stage s sits just before Gryphon write s; only a foreign
            // change AFTER Gryphon's own setting overrides it.
            if (!ws.some((w) => w.stage > lastSet))
                continue;
            const targetHas = lastSet >= 0
                ? field(ownChange[lastSet].next, w0) !== undefined
                : Object.prototype.hasOwnProperty.call(startBag, w0.key);
            const target = lastSet >= 0 ? field(ownChange[lastSet].next, w0) : startBag[w0.key];
            if (same(bag[w0.key], targetHas ? target : undefined))
                continue;
            if (targetHas)
                bag[w0.key] = target;
            else
                delete bag[w0.key];
            changed = true;
        }
        if (changed)
            reverted.push({ vaultKey: w0.vaultKey, hostId: w0.hostId, key: w0.field === "values" ? w0.key : `${w0.field}.${w0.key}` });
    }
    if (reverted.length) {
        // A reverted entry is rewritten whole (no unknown fields planted during
        // the reply survive); everything else keeps its bytes' meaning.
        const scopes = [...new Map(reverted.map((r) => [`${r.vaultKey}\u0000${r.hostId}`, [r.vaultKey, r.hostId]])).values()];
        const safeObj = _restoreUnknown(_composeForWrite(nowSafe, after, scopes, false), expectedUnknown);
        try {
            _save(safeObj, file, now);
        }
        catch (e) {
            // Review of 86d167a: a caller that can't save the undo still needs the
            // undone content (never the stored or recorded content as-is).
            _attachSafe(e, safeObj);
            throw e;
        }
        console.warn("[gryphon/security-settings] undid changes to Gryphon's security settings made outside Gryphon: " +
            reverted.map((r) => `${r.hostId}:${r.key}`).join(", "));
    }
    else if (unknownDrift) {
        if (_applyUnknownRestore(nowSafe, expectedUnknown, file, now))
            reverted.push({ vaultKey: "", hostId: "", key: "unrecognised settings" });
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
    onSecurityStoreTamper,
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
