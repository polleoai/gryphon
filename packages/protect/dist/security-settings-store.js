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
 */
const fs = require("fs");
const path = require("path");
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
    // `securityHostId` > manifest.id. The manifest ships inside the vault
    // (.obsidian/plugins/<dir>/manifest.json), so a vault could rename it to
    // another host's id and inherit that host's confirmed weakening values;
    // GryphonPlugin pins "gryphon" in code for that reason.
    const hp = input.hostPlugin;
    const hostId = input.hostId !== undefined && input.hostId !== null
        ? input.hostId
        : (hp && typeof hp.securityHostId === "string" && hp.securityHostId)
            || (hp && hp.manifest && hp.manifest.id);
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
function _parse(raw, file, stamp) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (_) {
        _report(file, stamp, `${file} is not valid JSON; every security setting uses its protected default`);
        return _empty();
    }
    if (!parsed || typeof parsed !== "object" || !parsed.vaults || typeof parsed.vaults !== "object" || Array.isArray(parsed.vaults)) {
        _report(file, stamp, `${file} has an unexpected shape; every security setting uses its protected default`);
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
                    _report(file, stamp, `${file}: dropped ${JSON.stringify(k)} (${ok.reason}); it uses its protected default`);
            }
            const dismissed = {};
            const rawDismissed = entry.dismissed && typeof entry.dismissed === "object" ? entry.dismissed : {};
            for (const [k, h] of Object.entries(rawDismissed)) {
                if (isWeakeningKey(k) && typeof h === "string" && HASH_RE.test(h))
                    dismissed[k] = h;
            }
            if (!store.vaults[vk])
                store.vaults[vk] = { hosts: Object.create(null) };
            store.vaults[vk].hosts[hostId] = { values, setAt: typeof entry.setAt === "string" ? entry.setAt : "", dismissed };
        }
    }
    return store;
}
let _cache = null;
function _stampOf(st) {
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
}
/** Read the store. Cached on (inode, size, mtime): one `stat` per lookup. */
function _load(file, fresh = false) {
    let st;
    try {
        st = fs.statSync(file);
    }
    catch (e) {
        if (e.code !== "ENOENT") {
            _report(file, "stat", `couldn't read ${file}; every security setting uses its protected default: ${e.message}`);
        }
        _cache = null;
        return _empty();
    }
    const stamp = _stampOf(st);
    if (!fresh && _cache && _cache.file === file && _cache.stamp === stamp)
        return _cache.store;
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (e) {
        _report(file, stamp, `couldn't read ${file}; every security setting uses its protected default: ${e.message}`);
        return _empty();
    }
    const store = _parse(raw, file, stamp);
    _cache = { file, stamp, store };
    return store;
}
/** Atomic write: 0700 dir, 0600 temp file in the same dir, rename over. */
function _save(store, file) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        try {
            fs.chmodSync(dir, 0o700);
        }
        catch (_) { }
    }
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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
    _cache = null;
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
/** Re-read right before writing; change only this scope's entry. */
function _update(scope, file, fn) {
    const store = _load(file, true);
    if (!store.vaults[scope.vaultKey])
        store.vaults[scope.vaultKey] = { hosts: Object.create(null) };
    const hosts = store.vaults[scope.vaultKey].hosts;
    if (!hosts[scope.hostId])
        hosts[scope.hostId] = { values: {}, setAt: "", dismissed: {} };
    fn(hosts[scope.hostId]);
    _save(store, file);
}
// ── public API ─────────────────────────────────────────────────────────
/** This scope's confirmed values (validated). */
function readMachineSecuritySettings(scope, opts = {}) {
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
    if (scope) {
        const entry = _entry(_load(opts.file || securitySettingsFilePath()), scope);
        if (entry) {
            machine = entry.values;
            dismissed = entry.dismissed;
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
    return _freezeDeep(out);
}
/** Just the nine weakening values of a snapshot (for comparisons / logs). */
function securityValuesOf(sec) {
    const out = {};
    for (const k of WEAKENING_KEYS)
        out[k] = sec ? sec[k] : undefined;
    return out;
}
/**
 * The security inputs for an enforcement call. `holder.security` (the
 * snapshot) wins. Without one, the caller's own settings object is used:
 * that's the library contract for headless callers that pass their config
 * directly. Gryphon's own call sites always pass a snapshot — the
 * no-direct-security-reads test keeps it that way.
 */
function securityInputsOf(holder) {
    if (holder && holder.security && typeof holder.security === "object")
        return holder.security;
    const settings = holder && ((holder.settings && typeof holder.settings === "object" && holder.settings)
        || (holder.plugin && holder.plugin.settings));
    return settings && typeof settings === "object" ? settings : {};
}
module.exports = {
    WEAKENING_KEYS,
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
