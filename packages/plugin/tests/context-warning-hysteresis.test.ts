/**
 * nextContextWarningState — hysteresis-decision tests for the 80%
 * one-shot warning. Encodes:
 *   - fire once when crossing 80% (and below 95%, since auto-compact
 *     takes over)
 *   - reset only when dropping below 75%
 *   - never fire repeatedly while bouncing within [75, 95)
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

const { nextContextWarningState } = require("../src/chat-view");

test("first cross-up to 80% fires once", () => {
  const r = nextContextWarningState({ shown: false }, 80);
  assert.deepEqual(r, { shown: true, fire: true });
});

test("85% with already-shown does NOT fire again", () => {
  const r = nextContextWarningState({ shown: true }, 85);
  assert.deepEqual(r, { shown: true, fire: false });
});

test("at-or-above 95% does NOT fire (auto-compact takes over)", () => {
  const r1 = nextContextWarningState({ shown: false }, 95);
  assert.deepEqual(r1, { shown: false, fire: false });
  const r2 = nextContextWarningState({ shown: false }, 100);
  assert.deepEqual(r2, { shown: false, fire: false });
});

test("hysteresis band: 75-79% with shown=true stays shown, no fire", () => {
  const r1 = nextContextWarningState({ shown: true }, 79);
  assert.deepEqual(r1, { shown: true, fire: false });
  const r2 = nextContextWarningState({ shown: true }, 75);
  assert.deepEqual(r2, { shown: true, fire: false });
});

test("dropping below 75% resets the flag, no fire", () => {
  const r = nextContextWarningState({ shown: true }, 74);
  assert.deepEqual(r, { shown: false, fire: false });
});

test("post-reset, climbing back to 80% fires again", () => {
  let state = { shown: true };
  state = nextContextWarningState(state, 70);   // reset
  state = nextContextWarningState(state, 80);   // re-fire
  assert.deepEqual(state, { shown: true, fire: true });
});

test("70% with shown=false does not fire (below threshold)", () => {
  const r = nextContextWarningState({ shown: false }, 70);
  assert.deepEqual(r, { shown: false, fire: false });
});

test("realistic climb: 70→80→85→90→78→74→81 fires twice total", () => {
  let state = { shown: false };
  const log = [];
  for (const pct of [70, 80, 85, 90, 78, 74, 81]) {
    state = nextContextWarningState(state, pct);
    if (state.fire) log.push(pct);
  }
  // Fires at first 80, drops below 75 at 74 to reset, fires again at 81.
  assert.deepEqual(log, [80, 81]);
});

test("zero / undefined prev defaults to not-shown", () => {
  assert.deepEqual(nextContextWarningState(null, 80),       { shown: true, fire: true });
  assert.deepEqual(nextContextWarningState(undefined, 80),  { shown: true, fire: true });
  assert.deepEqual(nextContextWarningState({}, 80),         { shown: true, fire: true });
});
