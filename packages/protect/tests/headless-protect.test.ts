const { test } = require("node:test");
const assert = require("node:assert/strict");

// CRITICAL: do NOT stub "obsidian" here — this test proves protect
// is reachable in a Node process that has no Obsidian module at all.
test("permission-gate + attack-detector load without obsidian module", () => {
  // Pre-condition: require("obsidian") should throw in this process.
  let obsidianAvailable = false;
  try { require("obsidian"); obsidianAvailable = true; } catch (_) { /* expected */ }
  assert.equal(obsidianAvailable, false, "test setup invariant: obsidian must not be installed");

  // If either file does `require("obsidian")` at module top-level, this throws.
  const permissionGate = require("../src/permission-gate");
  const attackDetector = require("../src/attack-detector");
  assert.equal(typeof permissionGate.checkPermission, "function");
  assert.equal(typeof attackDetector.classify, "function");
});
