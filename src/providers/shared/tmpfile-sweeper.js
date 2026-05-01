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

const fs = require("fs");
const pathMod = require("path");
const os = require("os");

const HOOK_SETTINGS_RE = /^gryphon-cc-settings-\d+-\d+-[0-9a-f]+\.json$/;
const SOCKET_RE = /^gryphon-(\d+)-[0-9a-f]+\.sock$/;
const PROVENANCE_TMP_RE = /^provenance\.json\.\d+\.[0-9a-f]+\.tmp$/;
const CHAT_HISTORY_TMP_RE = /^chat-history\.json\.tmp-(\d+)-\d+-[0-9a-z]+$/;

const DEFAULT_SETTINGS_CUTOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROVENANCE_TMP_CUTOFF_MS = 60 * 1000;
const HOOK_TRACE_LOG_NAME = "gryphon-hook-trace.log";

const IS_WINDOWS = process.platform === "win32";

function _tryUnlink(full) {
  try { fs.unlinkSync(full); return true; } catch (_) { return false; }
}

/**
 * Pid-liveness probe using signal 0. Returns true if a process with
 * the given pid is running (or exists under a different user — we
 * treat EPERM as "alive" defensively). False if ESRCH or pid is
 * nonsensical.
 */
function _isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function sweepHookSettingsOrphans({ tmpDir, cutoffMs = DEFAULT_SETTINGS_CUTOFF_MS } = {}) {
  const dir = tmpDir || os.tmpdir();
  const cutoff = Date.now() - cutoffMs;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return { removed: [] }; }
  const removed = [];
  for (const name of entries) {
    if (!HOOK_SETTINGS_RE.test(name)) continue;
    const full = pathMod.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff && _tryUnlink(full)) removed.push(full);
    } catch (_) { /* best-effort */ }
  }
  return { removed };
}

function sweepSocketOrphans({ tmpDir } = {}) {
  if (IS_WINDOWS) return { removed: [] };
  const dir = tmpDir || os.tmpdir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return { removed: [] }; }
  const removed = [];
  for (const name of entries) {
    const m = SOCKET_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || _isPidAlive(pid)) continue;
    const full = pathMod.join(dir, name);
    if (_tryUnlink(full)) removed.push(full);
  }
  return { removed };
}

function sweepProvenanceTmpOrphans({ pluginDir, cutoffMs = DEFAULT_PROVENANCE_TMP_CUTOFF_MS } = {}) {
  if (!pluginDir) return { removed: [] };
  const cutoff = Date.now() - cutoffMs;
  let entries;
  try { entries = fs.readdirSync(pluginDir); } catch (_) { return { removed: [] }; }
  const removed = [];
  for (const name of entries) {
    if (!PROVENANCE_TMP_RE.test(name)) continue;
    const full = pathMod.join(pluginDir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff && _tryUnlink(full)) removed.push(full);
    } catch (_) { /* best-effort */ }
  }
  return { removed };
}

function sweepChatHistoryTmpOrphans({ pluginDir } = {}) {
  if (!pluginDir) return { removed: [] };
  let entries;
  try { entries = fs.readdirSync(pluginDir); } catch (_) { return { removed: [] }; }
  const removed = [];
  for (const name of entries) {
    const m = CHAT_HISTORY_TMP_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || _isPidAlive(pid)) continue;
    const full = pathMod.join(pluginDir, name);
    if (_tryUnlink(full)) removed.push(full);
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
    if (fs.existsSync(full)) fs.truncateSync(full, 0);
    return { truncated: true, path: full };
  } catch (_) {
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

module.exports = {
  sweepGryphonOrphans,
  sweepHookSettingsOrphans,
  sweepSocketOrphans,
  sweepProvenanceTmpOrphans,
  sweepChatHistoryTmpOrphans,
  truncateHookTraceLog,
  _isPidAlive,
  HOOK_SETTINGS_RE,
  SOCKET_RE,
  PROVENANCE_TMP_RE,
  CHAT_HISTORY_TMP_RE,
};
