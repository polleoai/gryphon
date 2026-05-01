/**
 * Normalization regression tests for attack-detector.
 *
 * The classifier runs NFKC + zero-width-strip on command and path
 * strings before regex matching. This closes naive Unicode obfuscation
 * (fullwidth `ｒｍ`, zero-width joiners). Cyrillic homoglyphs remain
 * out of scope — documented in docs/adr/0001.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { classify } = require("../src/providers/shared/attack-detector");

function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-norm-"));
  return fs.realpathSync(dir);
}

const ctxWithSettings = (vaultRoot) => ({
  vaultRoot: vaultRoot || tempVault(),
  plugin: {
    settings: {
      protectedPathsEnabled: true,
      protectedCommandsEnabled: true,
      protectedPathsDisabled: [],
      protectedPathsCustom: [],
      protectedCommandsDisabled: [],
      protectedCommandsCustom: [],
    },
  },
});

test("NFKC: fullwidth rm is detected as rm", () => {
  const res = classify("Bash", { command: "ｒｍ -rf /tmp/foo" }, ctxWithSettings());
  assert.ok(res, "fullwidth rm should be classified");
  assert.equal(res.category, "destructive-operation");
});

test("zero-width chars inside rm are stripped", () => {
  // U+200B ZWSP between r and m
  const res = classify("Bash", { command: "r​m -rf /tmp/foo" }, ctxWithSettings());
  assert.ok(res, "zero-width separated rm should be classified");
});

test("mixed: fullwidth + zero-width", () => {
  const res = classify("Bash", { command: "ｒ​ｍ -rf /tmp/foo" }, ctxWithSettings());
  assert.ok(res, "fullwidth+zero-width rm should be classified");
});

test("ASCII rm still matches after normalization", () => {
  const res = classify("Bash", { command: "rm -rf /tmp/foo" }, ctxWithSettings());
  assert.ok(res, "plain ASCII rm should still match");
});

test("normalization does not false-positive on legit commands", () => {
  const res = classify("Bash", { command: "echo hello" }, ctxWithSettings());
  assert.equal(res, null, "plain echo should not match");
});

test("raw command is shown in technicalDetail, not normalized", () => {
  const raw = "ｒｍ -rf /tmp/foo";
  const res = classify("Bash", { command: raw }, ctxWithSettings());
  assert.ok(res);
  assert.ok(
    res.technicalDetail.includes(raw),
    "technicalDetail should show the original command the user sent, not the normalized one",
  );
});

test("path normalization works for zero-width in filename", () => {
  const res = classify(
    "Write",
    { file_path: ".obs​idian/plugins/gryphon/data.json" },
    ctxWithSettings(),
  );
  assert.ok(res, "zero-width obfuscated .obsidian path should match");
});

test("Cyrillic homoglyph is NOT caught (documented limitation)", () => {
  // `рm` where `р` is U+0440 Cyrillic small letter er (not Latin r).
  // This should NOT match — documented as known-gap in ADR-0001.
  const res = classify("Bash", { command: "рm -rf /tmp/foo" }, ctxWithSettings());
  assert.equal(res, null, "Cyrillic homoglyph is out of scope");
});
