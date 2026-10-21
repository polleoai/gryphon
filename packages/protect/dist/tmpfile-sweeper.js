"use strict";
// TypeScript module marker.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_HISTORY_TMP_RE = exports.PROVENANCE_TMP_RE = exports.SOCKET_RE = exports.MCP_CONFIG_RE = exports.HOOK_SETTINGS_RE = void 0;
exports.sweepGryphonOrphans = sweepGryphonOrphans;
exports.sweepHookSettingsOrphans = sweepHookSettingsOrphans;
exports.sweepSocketOrphans = sweepSocketOrphans;
exports.sweepProvenanceTmpOrphans = sweepProvenanceTmpOrphans;
exports.sweepChatHistoryTmpOrphans = sweepChatHistoryTmpOrphans;
exports.truncateHookTraceLog = truncateHookTraceLog;
exports._isPidAlive = _isPidAlive;
/**
 * Gryphon orphan-file sweeper (v0.6.0 Stage-8 QA follow-up).
 *
 * Single place that cleans up every temp file Gryphon can leave
 * behind. Called once per plugin onload. Consolidates what used to
 * be scattered ad-hoc sweeps across three files.
 *
 * What we sweep
 * -------------
 *   | File shape                              | Location        | Orphan when            |
 *   |-----------------------------------------|-----------------|------------------------|
 *   | gryphon-cc-settings-<pid>-<ts>-<hex>.json| os.tmpdir()     | 24h+ since last mtime  |
 *   | gryphon-cc-mcp-<pid>-<ts>-<n>.json      | os.tmpdir()     | 24h+ since last mtime  |
 *   | gryphon-cc-memory-<pid>-<ts>-<hex>.md   | os.tmpdir()     | 24h+ since last mtime  |
 *   | gryphon-<pid>-<hex>.sock                 | os.tmpdir()     | pid-in-name dead       |
 *   | provenance.json.<pid>.<hex>.tmp         | pluginDir       | 60s+ since last mtime  |
 *   | chat-history.json.tmp-<pid>-<ts>-<rand> | pluginDir       | pid-in-name dead       |
 *   | gryphon-hook-trace.log                   | os.tmpdir()     | truncated when dev on  |
 *
 * Guiding principles
 * ------------------
 *   1. Never touch files a concurrent Obsidian window might be
 *      using. We use pid-liveness checks where the filename encodes
 *      a pid (sockets, chat-history tmp), and time-since-mtime
 *      cutoffs where it doesn't (settings, provenance tmp).
 *   2. Best-effort: every delete is try/catch'd. A failed sweep
 *      doesn't block plugin load.
 *   3. Exported per-concern helpers so individual modules can still
 *      call their own sweep when it matters to them (e.g. the
 *      provenance store sweeps its own tmpdir before every load).
 */
const fs = __importStar(require("fs"));
const pathMod = __importStar(require("path"));
const os = __importStar(require("os"));
const HOOK_SETTINGS_RE = /^gryphon-cc-settings-\d+-\d+-[0-9a-f]+\.json$/;
exports.HOOK_SETTINGS_RE = HOOK_SETTINGS_RE;
// Issue #25: the claude-code provider's per-spawn --mcp-config file. Same
// lifecycle as the settings file (unlinked on CLI close), so a crash leaves
// it behind the same way — and it can carry MCP server env (tokens).
const MCP_CONFIG_RE = /^gryphon-cc-mcp-\d+-\d+-\d+\.json$/;
exports.MCP_CONFIG_RE = MCP_CONFIG_RE;
// Issue #27: the consumer memory file (--append-system-prompt-file). Same
// lifecycle again; holds the consumer's CLAUDE.md text.
const MEMORY_FILE_RE = /^gryphon-cc-memory-\d+-\d+-[0-9a-f]+\.md$/;
const SOCKET_RE = /^gryphon-(\d+)-[0-9a-f]+\.sock$/;
exports.SOCKET_RE = SOCKET_RE;
const PROVENANCE_TMP_RE = /^provenance\.json\.\d+\.[0-9a-f]+\.tmp$/;
exports.PROVENANCE_TMP_RE = PROVENANCE_TMP_RE;
const CHAT_HISTORY_TMP_RE = /^chat-history\.json\.tmp-(\d+)-\d+-[0-9a-z]+$/;
exports.CHAT_HISTORY_TMP_RE = CHAT_HISTORY_TMP_RE;
const DEFAULT_SETTINGS_CUTOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROVENANCE_TMP_CUTOFF_MS = 60 * 1000;
const HOOK_TRACE_LOG_NAME = "gryphon-hook-trace.log";
const IS_WINDOWS = process.platform === "win32";
function _tryUnlink(full) {
    try {
        fs.unlinkSync(full);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Pid-liveness probe using signal 0. Returns true if a process with
 * the given pid is running (or exists under a different user — we
 * treat EPERM as "alive" defensively). False if ESRCH or pid is
 * nonsensical.
 */
function _isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
function sweepHookSettingsOrphans({ tmpDir, cutoffMs = DEFAULT_SETTINGS_CUTOFF_MS } = {}) {
    const dir = tmpDir || os.tmpdir();
    const cutoff = Date.now() - cutoffMs;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return { removed: [] };
    }
    const removed = [];
    for (const name of entries) {
        if (!HOOK_SETTINGS_RE.test(name) && !MCP_CONFIG_RE.test(name) && !MEMORY_FILE_RE.test(name))
            continue;
        const full = pathMod.join(dir, name);
        try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs < cutoff && _tryUnlink(full))
                removed.push(full);
        }
        catch { /* best-effort */ }
    }
    return { removed };
}
function sweepSocketOrphans({ tmpDir } = {}) {
    if (IS_WINDOWS)
        return { removed: [] };
    const dir = tmpDir || os.tmpdir();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return { removed: [] };
    }
    const removed = [];
    for (const name of entries) {
        const m = SOCKET_RE.exec(name);
        if (!m)
            continue;
        const pid = Number(m[1]);
        if (pid === process.pid || _isPidAlive(pid))
            continue;
        const full = pathMod.join(dir, name);
        if (_tryUnlink(full))
            removed.push(full);
    }
    return { removed };
}
function sweepProvenanceTmpOrphans({ pluginDir, cutoffMs = DEFAULT_PROVENANCE_TMP_CUTOFF_MS } = {}) {
    if (!pluginDir)
        return { removed: [] };
    const cutoff = Date.now() - cutoffMs;
    let entries;
    try {
        entries = fs.readdirSync(pluginDir);
    }
    catch {
        return { removed: [] };
    }
    const removed = [];
    for (const name of entries) {
        if (!PROVENANCE_TMP_RE.test(name))
            continue;
        const full = pathMod.join(pluginDir, name);
        try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs < cutoff && _tryUnlink(full))
                removed.push(full);
        }
        catch { /* best-effort */ }
    }
    return { removed };
}
function sweepChatHistoryTmpOrphans({ pluginDir } = {}) {
    if (!pluginDir)
        return { removed: [] };
    let entries;
    try {
        entries = fs.readdirSync(pluginDir);
    }
    catch {
        return { removed: [] };
    }
    const removed = [];
    for (const name of entries) {
        const m = CHAT_HISTORY_TMP_RE.exec(name);
        if (!m)
            continue;
        const pid = Number(m[1]);
        if (pid === process.pid || _isPidAlive(pid))
            continue;
        const full = pathMod.join(pluginDir, name);
        if (_tryUnlink(full))
            removed.push(full);
    }
    return { removed };
}
/**
 * Truncate the hook-trace log on plugin load when CLI debug logging
 * is on. Prevents cross-session accumulation so each reload starts
 * the trace log fresh — otherwise a long-running Obsidian with debug
 * on would build up unbounded trace lines.
 */
function truncateHookTraceLog({ tmpDir } = {}) {
    const dir = tmpDir || os.tmpdir();
    const full = pathMod.join(dir, HOOK_TRACE_LOG_NAME);
    try {
        if (fs.existsSync(full))
            fs.truncateSync(full, 0);
        return { truncated: true, path: full };
    }
    catch {
        return { truncated: false, path: full };
    }
}
/**
 * One-stop sweeper. Call once at plugin onload. Returns a summary
 * object describing what was cleaned so the caller can log and tests
 * can assert.
 *
 * @param {object} opts
 *   pluginDir         — absolute path to the Gryphon plugin dir
 *   tmpDir            — override os.tmpdir() (tests)
 *   truncateTraceLog  — boolean; only truncate when devCliDebug is on
 */
function sweepGryphonOrphans(opts = {}) {
    const summary = {
        hookSettings: sweepHookSettingsOrphans({ tmpDir: opts.tmpDir }),
        sockets: sweepSocketOrphans({ tmpDir: opts.tmpDir }),
        provenanceTmp: sweepProvenanceTmpOrphans({ pluginDir: opts.pluginDir }),
        chatHistoryTmp: sweepChatHistoryTmpOrphans({ pluginDir: opts.pluginDir }),
    };
    if (opts.truncateTraceLog) {
        summary.traceLog = truncateHookTraceLog({ tmpDir: opts.tmpDir });
    }
    summary.totalRemoved =
        summary.hookSettings.removed.length +
            summary.sockets.removed.length +
            summary.provenanceTmp.removed.length +
            summary.chatHistoryTmp.removed.length;
    return summary;
}
