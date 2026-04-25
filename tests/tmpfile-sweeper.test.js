/**
 * Central orphan-file sweeper tests (v0.6.0 Stage-8 QA follow-up).
 *
 * Covers every temp-file class Gryphon produces. Pid-liveness sweeps
 * get tested with a real live pid (our own) as the "alive" case and
 * a definitely-dead pid for the "dead" case.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  sweepGryphonOrphans,
  sweepHookSettingsOrphans,
  sweepSocketOrphans,
  sweepProvenanceTmpOrphans,
  sweepChatHistoryTmpOrphans,
  truncateHookTraceLog,
  _isPidAlive,
} = require("../src/providers/shared/tmpfile-sweeper");

// ── helpers ────────────────────────────────────────────────────────────

function tempDir(prefix = "gryphon-sweeper-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function backdate(filePath, ageMs) {
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(filePath, t, t);
}

// A pid we can confidently assert is dead. 99999999 is above the
// default kernel pid_max on every platform we support, so kill(pid, 0)
// reliably throws ESRCH. (pid 1 is always alive, so we can test the
// "alive" branch with that.)
const DEAD_PID = 99_999_999;
const ALIVE_PID = 1;

// ── _isPidAlive ────────────────────────────────────────────────────────

test("_isPidAlive returns true for init (pid 1) on POSIX", { skip: process.platform === "win32" }, () => {
  assert.equal(_isPidAlive(ALIVE_PID), true);
});

test("_isPidAlive returns true for the current process pid", () => {
  assert.equal(_isPidAlive(process.pid), true);
});

test("_isPidAlive returns false for a pid well above pid_max", () => {
  assert.equal(_isPidAlive(DEAD_PID), false);
});

test("_isPidAlive returns false for nonsense pids", () => {
  assert.equal(_isPidAlive(0), false);
  assert.equal(_isPidAlive(-1), false);
  assert.equal(_isPidAlive(NaN), false);
  assert.equal(_isPidAlive(undefined), false);
});

// ── sweepHookSettingsOrphans ───────────────────────────────────────────

test("sweepHookSettingsOrphans removes files older than cutoff, preserves fresh ones", () => {
  const dir = tempDir();
  try {
    const stale = path.join(dir, "gryphon-cc-settings-12345-1234567890-abcd1234.json");
    const fresh = path.join(dir, "gryphon-cc-settings-67890-9999999999-deadbeef.json");
    const unrelated = path.join(dir, "unrelated-file.json");
    for (const p of [stale, fresh, unrelated]) fs.writeFileSync(p, "{}");
    backdate(stale, 48 * 60 * 60 * 1000);  // 48h past cutoff

    const { removed } = sweepHookSettingsOrphans({ tmpDir: dir });
    assert.equal(removed.length, 1);
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(unrelated));
  } finally { rmrf(dir); }
});

test("sweepHookSettingsOrphans tolerates a missing dir", () => {
  const { removed } = sweepHookSettingsOrphans({ tmpDir: "/definitely/does/not/exist/xyz" });
  assert.deepEqual(removed, []);
});

// ── sweepSocketOrphans ─────────────────────────────────────────────────

test("sweepSocketOrphans unlinks dead-pid sockets, preserves live-pid sockets",
     { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const dead = path.join(dir, `gryphon-${DEAD_PID}-abcd1234.sock`);
    const live = path.join(dir, `gryphon-${ALIVE_PID}-deadbeef.sock`);
    const unrelated = path.join(dir, "unrelated.sock");
    // We can't easily create real AF_UNIX sockets for the test; regular
    // files that match the pattern work for the path-existence / unlink
    // semantics the sweeper actually uses.
    for (const p of [dead, live, unrelated]) fs.writeFileSync(p, "");

    const { removed } = sweepSocketOrphans({ tmpDir: dir });
    assert.equal(removed.length, 1, `expected 1 removal, got ${removed.join(", ")}`);
    assert.ok(!fs.existsSync(dead));
    assert.ok(fs.existsSync(live), "live-pid socket must be preserved");
    assert.ok(fs.existsSync(unrelated), "non-matching file must not be touched");
  } finally { rmrf(dir); }
});

test("sweepSocketOrphans preserves our own pid's sockets (we're still alive)", () => {
  const dir = tempDir();
  try {
    const mine = path.join(dir, `gryphon-${process.pid}-11111111.sock`);
    fs.writeFileSync(mine, "");
    const { removed } = sweepSocketOrphans({ tmpDir: dir });
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(mine));
  } finally { rmrf(dir); }
});

// ── sweepProvenanceTmpOrphans ──────────────────────────────────────────

test("sweepProvenanceTmpOrphans removes old provenance .tmp files, preserves recent ones", () => {
  const dir = tempDir();
  try {
    const stale = path.join(dir, "provenance.json.12345.abcd1234.tmp");
    const fresh = path.join(dir, "provenance.json.67890.deadbeef.tmp");
    const realFile = path.join(dir, "provenance.json");  // not a .tmp
    for (const p of [stale, fresh, realFile]) fs.writeFileSync(p, "{}");
    backdate(stale, 120_000);  // 2 minutes > 60s cutoff

    const { removed } = sweepProvenanceTmpOrphans({ pluginDir: dir });
    assert.equal(removed.length, 1);
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(realFile), "real provenance.json must not be touched");
  } finally { rmrf(dir); }
});

test("sweepProvenanceTmpOrphans returns empty when pluginDir is falsy", () => {
  assert.deepEqual(sweepProvenanceTmpOrphans({}).removed, []);
});

// ── sweepChatHistoryTmpOrphans ─────────────────────────────────────────

test("sweepChatHistoryTmpOrphans unlinks dead-pid tmp files, preserves live-pid",
     { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const dead = path.join(dir, `chat-history.json.tmp-${DEAD_PID}-1234567890-abc123`);
    const live = path.join(dir, `chat-history.json.tmp-${ALIVE_PID}-9999999999-def456`);
    const realFile = path.join(dir, "chat-history.json");
    for (const p of [dead, live, realFile]) fs.writeFileSync(p, "[]");

    const { removed } = sweepChatHistoryTmpOrphans({ pluginDir: dir });
    assert.equal(removed.length, 1);
    assert.ok(!fs.existsSync(dead));
    assert.ok(fs.existsSync(live));
    assert.ok(fs.existsSync(realFile), "real chat-history.json must not be touched");
  } finally { rmrf(dir); }
});

// ── truncateHookTraceLog ───────────────────────────────────────────────

test("truncateHookTraceLog zeroes the trace file when it exists", () => {
  const dir = tempDir();
  try {
    const trace = path.join(dir, "gryphon-hook-trace.log");
    fs.writeFileSync(trace, "old content that should be erased\n".repeat(100));
    const res = truncateHookTraceLog({ tmpDir: dir });
    assert.equal(res.truncated, true);
    assert.equal(fs.statSync(trace).size, 0);
  } finally { rmrf(dir); }
});

test("truncateHookTraceLog no-ops gracefully when the file doesn't exist", () => {
  const dir = tempDir();
  try {
    const res = truncateHookTraceLog({ tmpDir: dir });
    assert.equal(res.truncated, true);  // "nothing to truncate" is success
  } finally { rmrf(dir); }
});

// ── sweepGryphonOrphans (integration) ───────────────────────────────────

test("sweepGryphonOrphans runs every concern in one call and reports totals", () => {
  const tmp = tempDir("gryphon-sweeper-tmpdir-");
  const plug = tempDir("gryphon-sweeper-plugindir-");
  try {
    // Plant one orphan in each category.
    const settingsStale = path.join(tmp, "gryphon-cc-settings-11111-1111111111-aaaa1111.json");
    const socketDead = path.join(tmp, `gryphon-${DEAD_PID}-bbbb2222.sock`);
    const provTmpStale = path.join(plug, "provenance.json.22222.cccc3333.tmp");
    const chatTmpDead = path.join(plug, `chat-history.json.tmp-${DEAD_PID}-3333333333-xyz789`);
    for (const p of [settingsStale, socketDead, provTmpStale, chatTmpDead]) fs.writeFileSync(p, "");
    backdate(settingsStale, 48 * 60 * 60 * 1000);
    backdate(provTmpStale, 120_000);

    const s = sweepGryphonOrphans({ tmpDir: tmp, pluginDir: plug });
    // Each per-concern result:
    assert.equal(s.hookSettings.removed.length, 1);
    assert.equal(s.provenanceTmp.removed.length, 1);
    if (process.platform !== "win32") {
      assert.equal(s.sockets.removed.length, 1);
      assert.equal(s.chatHistoryTmp.removed.length, 1);
      assert.equal(s.totalRemoved, 4);
    } else {
      // Socket + chat-history-tmp sweeps rely on POSIX pid semantics
      // which Windows doesn't honour the same way; the sweeper no-ops
      // or degrades gracefully on Windows.
      assert.ok(s.totalRemoved >= 2);
    }
    assert.ok(!fs.existsSync(settingsStale));
    assert.ok(!fs.existsSync(provTmpStale));
  } finally { rmrf(tmp); rmrf(plug); }
});

test("sweepGryphonOrphans truncates trace log only when asked", () => {
  const tmp = tempDir("gryphon-sweeper-tmpdir-");
  const plug = tempDir("gryphon-sweeper-plugindir-");
  try {
    const trace = path.join(tmp, "gryphon-hook-trace.log");
    fs.writeFileSync(trace, "some dev-only log lines\n".repeat(50));
    const sizeBefore = fs.statSync(trace).size;

    // Without opt-in: trace is NOT touched.
    const s1 = sweepGryphonOrphans({ tmpDir: tmp, pluginDir: plug });
    assert.equal(s1.traceLog, undefined);
    assert.equal(fs.statSync(trace).size, sizeBefore);

    // With opt-in: trace is truncated.
    const s2 = sweepGryphonOrphans({ tmpDir: tmp, pluginDir: plug, truncateTraceLog: true });
    assert.equal(s2.traceLog.truncated, true);
    assert.equal(fs.statSync(trace).size, 0);
  } finally { rmrf(tmp); rmrf(plug); }
});
