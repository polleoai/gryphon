/**
 * Regression tests for the auto-deny + CLI hook fix.
 *
 * Bug (pre-fix): in Claude Code mode with Protected Mode ON + Auto-deny ON,
 * hooks were disabled — only byte-exact permissions.deny globs ran.
 * This meant NFKC normalization never fired and fullwidth/zero-width
 * obfuscated commands bypassed protection. Observed on Windows CLI
 * with `ｒｍ c:\tmp\nothing`.
 *
 * Fix: enable hooks in auto-deny mode too (classify() with its
 * normalization becomes the catch-all for shapes the deny-globs miss),
 * and short-circuit to `allow` in _handleClassifyRequest for
 * non-matching calls so the "no modal for routine ops" contract of
 * auto-deny still holds.
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

const { classify } = require("../src/attack-detector");

const ctx = (opts = {}) => ({
  vaultRoot: "/tmp/vault",
  plugin: {
    settings: {
      protectedMode: true,
      autoDenyProtected: opts.autoDeny === true,
      protectedPathsEnabled: true,
      protectedCommandsEnabled: true,
      protectedPathsDisabled: [],
      protectedPathsCustom: [],
      protectedCommandsDisabled: [],
      protectedCommandsCustom: [],
    },
  },
});

// ── Classifier-level guarantees the hook relies on ──────────────────

test("fullwidth ｒｍ is classified (modal mode context)", () => {
  const res = classify("Bash", { command: "ｒｍ /tmp/nothing" }, ctx({ autoDeny: false }));
  assert.ok(res, "classify should match fullwidth rm");
  assert.equal(res.category, "destructive-operation");
});

test("fullwidth ｒｍ is classified in auto-deny context too", () => {
  // In the live CLI flow, the hook runs regardless of auto-deny state
  // after the fix. classify() has no special auto-deny branch — the
  // same classification comes out either way, and gate() is the one
  // that decides modal-vs-auto-deny based on settings.
  const res = classify("Bash", { command: "ｒｍ c:\\\\tmp\\\\nothing" }, ctx({ autoDeny: true }));
  assert.ok(res, "classify should match fullwidth rm regardless of auto-deny state");
});

test("zero-width-joined r​m is classified in auto-deny context", () => {
  // U+200B between r and m
  const res = classify("Bash", { command: "r​m /tmp/foo" }, ctx({ autoDeny: true }));
  assert.ok(res);
});

// ── enableHooks condition no longer requires !autoDenyProtected ─────

test("claude-code module source no longer gates enableHooks on !autoDenyProtected", () => {
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../provider-runtime/src/providers/claude-code/claude-code.js"),
    "utf8",
  );
  // Find the enableHooks definition and verify it doesn't short-circuit
  // on autoDenyProtected. Concrete check: the word `!autoDenyProtected`
  // must not appear as a conjunct inside `const enableHooks = ...`
  // The fix is to rely on the gate() auto-deny branch in permission-
  // gate.js line 90 instead, which correctly returns deny without
  // modal when isProtected && autoDenyProtected.
  const enableHooksBlock = src.match(/const enableHooks\s*=[\s\S]*?;/);
  assert.ok(enableHooksBlock, "should find enableHooks definition");
  assert.ok(
    !enableHooksBlock[0].includes("!autoDenyProtected"),
    "enableHooks must NOT require !autoDenyProtected — the hook needs to run in auto-deny mode to apply NFKC normalization that byte-exact deny-globs can't do",
  );
});

test("_handleClassifyRequest short-circuits to allow for non-classified calls in auto-deny mode", () => {
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../plugin/src/plugin.js"),
    "utf8",
  );
  // Concrete check: there must be a short-circuit in
  // _handleClassifyRequest that returns allow when classification is
  // null AND autoDenyProtected is true. Without this, every non-
  // matching Bash call in auto-deny mode would fall through to gate()
  // and modal-prompt in default permission mode — regressing the
  // "no prompts for routine ops" contract of auto-deny.
  assert.ok(
    /!classification\s*&&\s*this\.settings\.autoDenyProtected\s*===\s*true/.test(src),
    "plugin.js must short-circuit to allow when auto-deny is ON and no classification match",
  );
});
