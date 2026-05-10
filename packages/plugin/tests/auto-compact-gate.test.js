/**
 * shouldStartAutoCompact — decision-table tests for the SDK
 * auto-compact gate. Pins every false-return branch so future tweaks
 * to the gate's logic can't silently start auto-compacting in CC mode
 * or with the user's opt-out flag set.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { shouldStartAutoCompact } = require("../src/chat-view");

const baseOk = {
  pct: 96,
  isSdk: true,
  autoCompactSdk: true,
  isCompacting: false,
  messageCount: 10,
  lagFailsafe: false,
};

test("happy path: SDK + 96% + enabled + idle + enough messages → true", () => {
  assert.equal(shouldStartAutoCompact(baseOk), true);
});

test("CC mode never auto-compacts", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, isSdk: false }), false);
});

test("setting disabled → false (even at 100%)", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, autoCompactSdk: false, pct: 100 }), false);
});

test("already compacting → false (no concurrent compactions)", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, isCompacting: true }), false);
});

test("below threshold → false", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, pct: 94 }), false);
  assert.equal(shouldStartAutoCompact({ ...baseOk, pct: 0 }), false);
});

test("at exact 95% threshold → true", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, pct: 95 }), true);
});

test("too few messages → false (nothing to summarize)", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, messageCount: 0 }), false);
  assert.equal(shouldStartAutoCompact({ ...baseOk, messageCount: 3 }), false);
  assert.equal(shouldStartAutoCompact({ ...baseOk, messageCount: 4 }), true);
});

test("lag-failsafe bypasses pct threshold", () => {
  assert.equal(
    shouldStartAutoCompact({ ...baseOk, pct: 50, lagFailsafe: true }),
    true,
    "lag-failsafe should fire even at 50%"
  );
});

test("lag-failsafe still respects setting + isSdk + isCompacting + messageCount", () => {
  assert.equal(
    shouldStartAutoCompact({ ...baseOk, pct: 50, lagFailsafe: true, autoCompactSdk: false }),
    false
  );
  assert.equal(
    shouldStartAutoCompact({ ...baseOk, pct: 50, lagFailsafe: true, isSdk: false }),
    false
  );
  assert.equal(
    shouldStartAutoCompact({ ...baseOk, pct: 50, lagFailsafe: true, isCompacting: true }),
    false
  );
  assert.equal(
    shouldStartAutoCompact({ ...baseOk, pct: 50, lagFailsafe: true, messageCount: 2 }),
    false
  );
});

test("null/undefined pct without lagFailsafe → false", () => {
  assert.equal(shouldStartAutoCompact({ ...baseOk, pct: null }), false);
  assert.equal(shouldStartAutoCompact({ ...baseOk, pct: undefined }), false);
});
