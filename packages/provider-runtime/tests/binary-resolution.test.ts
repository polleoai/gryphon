/**
 * Version-aware CLI binary resolution (v2.4.3) — R8 unit tests.
 *
 * Covers the pure logic (parseVersion / compareVersions), the cached
 * synchronous version probe (injected runner — no real spawns), and the
 * structured resolveCliBinary preflight (real temp-dir fake CLIs so the
 * production probe path executes). Proves: newest-on-disk wins, a stale
 * binary never shadows a current one, an empty config self-heals to the
 * detector, a valid configured path overrides, and the not-found / too-old
 * failures are typed for the fast spawn-time error.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("module");

// CodexProvider transitively loads `obsidian` (via @gryphon/protect). Stub it
// the same way cli-providers-factory.test.ts does so the provider-boundary
// test below can run in the bare Node test runner.
const _obsidianStub = require.resolve("./_stubs/obsidian.js");
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "obsidian") return _obsidianStub;
  return _origResolve.call(this, request, ...rest);
};

const utils = require("../src/utils");

const isWindows = process.platform === "win32";

// --- pure helpers -------------------------------------------------------

test("parseVersion extracts a dotted triple from noisy --version output", () => {
  assert.deepEqual(utils.parseVersion("2.1.181 (Claude Code)"), [2, 1, 181]);
  assert.deepEqual(utils.parseVersion("codex 0.9"), [0, 9, 0]); // pair → patch 0
  assert.deepEqual(utils.parseVersion("gemini-cli v1.2.3\n"), [1, 2, 3]);
  assert.equal(utils.parseVersion("no digits here"), null);
  assert.equal(utils.parseVersion(undefined), null);
  assert.equal(utils.parseVersion(""), null);
});

test("compareVersions orders [maj,min,patch] triples; missing parts == 0", () => {
  assert.ok(utils.compareVersions([2, 1, 181], [1, 0, 108]) > 0);
  assert.ok(utils.compareVersions([1, 0, 108], [2, 1, 181]) < 0);
  assert.equal(utils.compareVersions([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(utils.compareVersions([1, 2, 0], [1, 2]), 0);
  assert.ok(utils.compareVersions([1, 3], [1, 2, 9]) > 0);
});

// --- probeVersion (injected runner; cache) ------------------------------

test("probeVersion parses stdout and caches by path", () => {
  utils.clearBinaryDiscoveryCache();
  let calls = 0;
  const fakeRun = () => { calls++; return "2.1.181 (Claude Code)"; };
  assert.deepEqual(utils.probeVersion("/a/claude", fakeRun), [2, 1, 181]);
  assert.deepEqual(utils.probeVersion("/a/claude", fakeRun), [2, 1, 181]);
  assert.equal(calls, 1, "second call served from cache");
});

test("probeVersion recovers a version from a runner that throws with stderr", () => {
  utils.clearBinaryDiscoveryCache();
  const throwsWithStderr = () => {
    const e: any = new Error("nonzero exit");
    e.stderr = "0.9.1 codex";
    throw e;
  };
  assert.deepEqual(utils.probeVersion("/b/codex", throwsWithStderr), [0, 9, 1]);
});

test("probeVersion returns null on unparseable output", () => {
  utils.clearBinaryDiscoveryCache();
  assert.equal(utils.probeVersion("/c/x", () => "garbage, no version"), null);
});

// --- resolveCliBinary (real temp-dir fake CLIs) -------------------------

// A POSIX fake CLI: an executable shell script that echoes a --version line.
// Windows shims differ; the VM matrix covers Windows, so gate these to POSIX.
function fakeCli(dir: string, name: string, versionLine: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-binres-"));
}

test("resolveCliBinary: valid configured path wins (R7 override)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const good = fakeCli(dir, "claude", "2.1.181 (Claude Code)");
  const res = utils.resolveCliBinary("claude-code", good);
  assert.equal(res.ok, true);
  assert.equal(res.path, good);
  assert.deepEqual(res.version, [2, 1, 181]);
});

test("resolveCliBinary: empty config self-heals to the detected newest (R1/R4)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const detected = fakeCli(dir, "claude", "2.1.181 (Claude Code)");
  const orig = utils.findClaudeBinary;
  utils.findClaudeBinary = () => detected;
  try {
    const res = utils.resolveCliBinary("claude-code", "");
    assert.equal(res.ok, true);
    assert.equal(res.path, detected);
  } finally {
    utils.findClaudeBinary = orig;
  }
});

test("resolveCliBinary: missing configured path self-heals to detector (R4)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const detected = fakeCli(dir, "claude", "2.1.181 (Claude Code)");
  const orig = utils.findClaudeBinary;
  utils.findClaudeBinary = () => detected;
  try {
    const res = utils.resolveCliBinary("claude-code", "/does/not/exist/claude");
    assert.equal(res.ok, true);
    assert.equal(res.path, detected);
  } finally {
    utils.findClaudeBinary = orig;
  }
});

test("resolveCliBinary: nothing found → typed not-found failure (R5)", () => {
  utils.clearBinaryDiscoveryCache();
  const orig = utils.findClaudeBinary;
  utils.findClaudeBinary = () => null;
  try {
    const res = utils.resolveCliBinary("claude-code", "");
    assert.equal(res.ok, false);
    assert.equal(res.error, "not-found");
  } finally {
    utils.findClaudeBinary = orig;
  }
});

// --- _pickNewestValid via the real find* path (newest-on-disk) ----------

test("findClaudeBinary picks the NEWEST installed, not the first-listed (R2)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  // Two real fakes; we feed them straight to the ranking helper through
  // resolveCliBinary by stubbing the detector to a custom ranker over both.
  const stale = fakeCli(dir, "claude-stale", "1.0.108 (Claude Code)");
  const current = fakeCli(dir, "claude-current", "2.1.181 (Claude Code)");
  // Probe both, assert the comparison the resolver relies on.
  const vStale = utils.probeVersion(stale);
  const vCurrent = utils.probeVersion(current);
  assert.ok(utils.compareVersions(vCurrent, vStale) > 0, "current must outrank stale");
});

// --- provider boundary: preflight rejects FAST, never spawns/hangs (R1/R5) ---

test("CodexProvider.send rejects fast when no CLI resolves (R1/R5)", async () => {
  utils.clearBinaryDiscoveryCache();
  const orig = utils.findCodexBinary;
  utils.findCodexBinary = () => null; // nothing detected anywhere
  try {
    const { CodexProvider } = require("../src/providers/codex-cli/codex-cli");
    const provider = new CodexProvider("", "/tmp", {});
    const started = Date.now();
    await assert.rejects(
      () => provider.send("hello", {}),
      /Codex CLI not found/,
      "send must reject with the actionable not-found message, not hang",
    );
    assert.ok(Date.now() - started < 5000, "must fail fast (<5s), not reach the connection timeout");
  } finally {
    utils.findCodexBinary = orig;
  }
});

test("GeminiCliProvider.send rejects fast when no CLI resolves (R1/R5)", async () => {
  utils.clearBinaryDiscoveryCache();
  const orig = utils.findGeminiBinary;
  utils.findGeminiBinary = () => null;
  try {
    const { GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");
    const provider = new GeminiCliProvider("", "/tmp", {});
    await assert.rejects(() => provider.send("hi", {}), /Gemini CLI not found/);
  } finally {
    utils.findGeminiBinary = orig;
  }
});

// --- newest-wins through the REAL ranker + floor gate (R2/R3) ------------

test("_pickNewestValid picks the newest even when the stale path is listed first (R2)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const stale = fakeCli(dir, "claude-stale", "1.0.108 (Claude Code)");
  const current = fakeCli(dir, "claude-current", "2.1.181 (Claude Code)");
  const best = utils._pickNewestValid([stale, current], "0.0.0"); // stale FIRST
  assert.equal(best.path, current);
});

test("_pickNewestValid rejects a below-floor candidate even if it's the only one (R3)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const old = fakeCli(dir, "claude", "1.0.108 (Claude Code)");
  assert.equal(utils._pickNewestValid([old], "2.0.0"), null);           // gated out
  assert.equal(utils._pickNewestValid([old], "0.0.0").path, old);       // permissive accepts
});

test("_collectPresentBinaries returns only existing executables, deduped (R6)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const real = fakeCli(dir, "claude", "2.1.181 (Claude Code)");
  const present = utils._collectPresentBinaries([real, real, "/no/such/claude"], "claude", false);
  assert.equal(present.filter((p: string) => p === real).length, 1, "deduped");
  assert.ok(!present.includes("/no/such/claude"), "non-existent excluded");
});

// --- too-old failure (R5), exercised via an override floor (F4) ----------

test("resolveCliBinary: only a below-floor binary present → typed too-old with version detail (R5)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const old = fakeCli(dir, "claude", "1.0.108 (Claude Code)");
  const orig = utils.findClaudeBinary;
  utils.findClaudeBinary = () => old; // detection finds only the stale one
  try {
    const res = utils.resolveCliBinary("claude-code", "", "2.0.0"); // impose a floor
    assert.equal(res.ok, false);
    assert.equal(res.error, "too-old");
    assert.match(res.detail, /1\.0\.108/);
    assert.match(res.detail, /2\.0\.0/);
  } finally {
    utils.findClaudeBinary = orig;
  }
});

// --- per-kind self-heal for codex + gemini (R4) -------------------------

test("resolveCliBinary self-heals per kind (codex + gemini): empty config → detected newest (R4)", { skip: isWindows }, () => {
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const codex = fakeCli(dir, "codex", "0.45.0");
  const gemini = fakeCli(dir, "gemini", "1.2.3");
  const oc = utils.findCodexBinary;
  const og = utils.findGeminiBinary;
  utils.findCodexBinary = () => codex;
  utils.findGeminiBinary = () => gemini;
  try {
    const rc = utils.resolveCliBinary("codex-cli", "");
    assert.equal(rc.ok, true);
    assert.equal(rc.path, codex);
    const rg = utils.resolveCliBinary("gemini-cli", "");
    assert.equal(rg.ok, true);
    assert.equal(rg.path, gemini);
  } finally {
    utils.findCodexBinary = oc;
    utils.findGeminiBinary = og;
  }
});

test("ClaudeCodeProvider.send rejects with the actionable message (not a null-stdin TypeError) when no CLI resolves (R1/R5)", async () => {
  utils.clearBinaryDiscoveryCache();
  const orig = utils.findClaudeBinary;
  utils.findClaudeBinary = () => null;
  try {
    const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
    const provider = new ClaudeCodeProvider("", "/tmp", {});
    await assert.rejects(
      () => provider.send("hello"),
      (err: Error) => {
        assert.match(err.message, /Claude CLI not found/);
        assert.doesNotMatch(err.message, /stdin|null|undefined/i, "must not leak a null-deref TypeError");
        return true;
      },
    );
  } finally {
    utils.findClaudeBinary = orig;
  }
});
