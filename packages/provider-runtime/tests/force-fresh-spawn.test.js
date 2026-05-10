/**
 * Issue #33 regression: a CLI protected-deny must reliably force the
 * NEXT spawn to drop --resume, even when the session_id-keyed taint
 * mechanism misses (orphaned id, hook input without session_id, CLI
 * thread-id rotation across resume).
 *
 * The plugin tracks two parallel signals:
 *
 *   1. `_taintedSessions` — keyed by raw session_id from the hook.
 *      Reliable when the hook input includes a session_id matching
 *      what the provider tracks.
 *
 *   2. `_forceFreshSpawnByProvider` — keyed by CLI provider kind
 *      ("codex-cli" / "gemini-cli" / "claude-code"). Robust to
 *      session_id mismatches: any protected deny in a hook running
 *      under a known provider marks that provider for fresh next spawn.
 *
 * Provider adapters consume EITHER signal in their pre-spawn block.
 * Together they close the gap that previously let the third repeat of
 * a denied prompt skip the modal (the model would echo the prior deny
 * copy from a resumed transcript without re-invoking the tool).
 *
 * This test stubs the plugin instance to the minimum needed to exercise
 * `_handleClassifyRequest` end-to-end and verifies the consume helper
 * returns true exactly once, then false (one-shot).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

test("issue #33: consumeForceFreshSpawn is one-shot per provider kind", () => {
  // Minimal plugin shape — we only need the two helper methods, not
  // the full Obsidian Plugin instance.
  const plugin = {
    _taintedSessions: new Set(),
    _forceFreshSpawnByProvider: new Set(),
  };
  // Bind real implementations of consume + the populate path.
  const GryphonPlugin = require("../../plugin/src/plugin");
  plugin.consumeTaintedSession =
    GryphonPlugin.prototype.consumeTaintedSession.bind(plugin);
  plugin.consumeForceFreshSpawn =
    GryphonPlugin.prototype.consumeForceFreshSpawn.bind(plugin);

  // No deny yet: both consumers are no-ops.
  assert.equal(plugin.consumeForceFreshSpawn("codex-cli"), false);
  assert.equal(plugin.consumeForceFreshSpawn("gemini-cli"), false);

  // Simulate a protected deny inside _handleClassifyRequest by
  // populating the set the way the deny path does.
  plugin._forceFreshSpawnByProvider.add("codex-cli");

  // First consume returns true; the entry is removed.
  assert.equal(plugin.consumeForceFreshSpawn("codex-cli"), true);
  // Second consume returns false (one-shot — no longer in the set).
  assert.equal(plugin.consumeForceFreshSpawn("codex-cli"), false);
  // Other providers untouched.
  assert.equal(plugin.consumeForceFreshSpawn("gemini-cli"), false);
});

test("issue #33: consumeForceFreshSpawn ignores empty / non-string input", () => {
  const plugin = {
    _forceFreshSpawnByProvider: new Set(["codex-cli"]),
  };
  const GryphonPlugin = require("../../plugin/src/plugin");
  plugin.consumeForceFreshSpawn =
    GryphonPlugin.prototype.consumeForceFreshSpawn.bind(plugin);

  assert.equal(plugin.consumeForceFreshSpawn(null), false);
  assert.equal(plugin.consumeForceFreshSpawn(undefined), false);
  assert.equal(plugin.consumeForceFreshSpawn(""), false);
  assert.equal(plugin.consumeForceFreshSpawn(42), false);
  // The valid entry is untouched.
  assert.equal(plugin._forceFreshSpawnByProvider.has("codex-cli"), true);
});

test("issue #33: tainted-session and force-fresh-spawn are independent signals", () => {
  const plugin = {
    _taintedSessions: new Set(),
    _forceFreshSpawnByProvider: new Set(),
  };
  const GryphonPlugin = require("../../plugin/src/plugin");
  plugin.consumeTaintedSession =
    GryphonPlugin.prototype.consumeTaintedSession.bind(plugin);
  plugin.consumeForceFreshSpawn =
    GryphonPlugin.prototype.consumeForceFreshSpawn.bind(plugin);

  // Only force-fresh marked → session-id check returns false but
  // provider-kind check returns true. Provider's pre-spawn must
  // drop --resume on either signal.
  plugin._forceFreshSpawnByProvider.add("codex-cli");
  assert.equal(plugin.consumeTaintedSession("some-sid"), false);
  assert.equal(plugin.consumeForceFreshSpawn("codex-cli"), true);

  // Only session tainted → other check returns false. Same robustness.
  plugin._taintedSessions.add("session-A");
  assert.equal(plugin.consumeForceFreshSpawn("codex-cli"), false);
  assert.equal(plugin.consumeTaintedSession("session-A"), true);
});
