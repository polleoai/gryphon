/**
 * computeContextPct — pure boundary tests for the SDK auto-compact
 * threshold math. The chat-view's `_currentContextPct` mirrors this
 * function; pinning the boundaries here means the meter color, the
 * 80% one-shot warning, and the 95% auto-compact gate all stay
 * mathematically aligned.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian so chat-view.js can be required under node:test.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { computeContextPct } = require("../src/chat-view");

test("zero tokens → 0%", () => {
  assert.equal(computeContextPct(0, 200000), 0);
});

test("zero / negative window → 0% (defensive)", () => {
  assert.equal(computeContextPct(50000, 0), 0);
  assert.equal(computeContextPct(50000, -1), 0);
});

test("rounds to nearest integer", () => {
  // 49.5% → 50, 49.4% → 49 (Math.round)
  assert.equal(computeContextPct(99000, 200000), 50);
  assert.equal(computeContextPct(98800, 200000), 49);
});

test("caps at 100% even when tokens exceed window", () => {
  assert.equal(computeContextPct(250000, 200000), 100);
  assert.equal(computeContextPct(1_000_000, 200000), 100);
});

test("80% boundary is exact at 160000/200000", () => {
  assert.equal(computeContextPct(160000, 200000), 80);
  // One token under → 79
  assert.equal(computeContextPct(158000, 200000), 79);
});

test("95% boundary is exact at 190000/200000", () => {
  assert.equal(computeContextPct(190000, 200000), 95);
  // 94.6% rounds to 95
  assert.equal(computeContextPct(189200, 200000), 95);
  // 94.4% rounds to 94 — just below the auto-compact line
  assert.equal(computeContextPct(188800, 200000), 94);
});

test("1M-context model scales correctly", () => {
  assert.equal(computeContextPct(800000, 1_000_000), 80);
  assert.equal(computeContextPct(950000, 1_000_000), 95);
});
