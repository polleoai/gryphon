/**
 * Issue #4 — getProjectionCalibrationDelta() must be guarded by its own
 * presence, not the sibling recordProjectionCalibrationSample's.
 *
 * In updateContextMeter's self-tuning calibration block, the delta read was
 * nested under `typeof recordProjectionCalibrationSample === "function"`. A
 * host that implements recordProjectionCalibrationSample but NOT
 * getProjectionCalibrationDelta would throw there — the one optional-method
 * call site not guarded by its own presence (the #3 contract says each is
 * "typeof-guarded at each call site").
 *
 * Tested by driving updateContextMeter with the calibration preconditions
 * met and a small token count (so pct is ~1% and the DOM warning branches
 * are skipped), against a host missing getProjectionCalibrationDelta.
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

const { GryphonChatView } = require("../src/chat-view");

function makeMeterView(plugin) {
  const view = Object.create(GryphonChatView.prototype);
  view.plugin = plugin;
  // Calibration preconditions: a prior projection exists, and the new
  // contextTokens differs from the last calibrated value.
  view._projectionLastResult = { totalTokens: 1000 };
  view._lastCalibratedTokens = 0;
  view._lastMeasuredTokens = 0;
  view._contextWarningShown = false;
  view._calibrationDelta = 0;
  // Minimal DOM stub for the chip update that follows the calibration block.
  view.contextBtn = {
    textContent: "",
    removeClass() {},
    addClass() {},
  };
  return view;
}

test("updateContextMeter does not throw when host has recordProjectionCalibrationSample but not getProjectionCalibrationDelta", () => {
  let recorded = null;
  const view = makeMeterView({
    settings: { model: "claude-sonnet-4-6" },
    recordProjectionCalibrationSample: (d) => { recorded = d; },
    // getProjectionCalibrationDelta intentionally absent.
  });

  // 1100 tokens vs projected 1000 → delta 100, within the windowSize/2 bound;
  // pct ≈ 1% so the warning/flash branches are skipped.
  assert.doesNotThrow(() => view.updateContextMeter(1100));
  assert.equal(recorded, 100, "the sample should still be recorded via the host hook");
});

test("updateContextMeter still reads getProjectionCalibrationDelta when the host provides both", () => {
  let readDelta = 0;
  const view = makeMeterView({
    settings: { model: "claude-sonnet-4-6" },
    recordProjectionCalibrationSample: () => {},
    getProjectionCalibrationDelta: () => { readDelta += 1; return 42; },
  });

  view.updateContextMeter(1100);

  assert.equal(readDelta, 1, "getProjectionCalibrationDelta should be read once when present");
  assert.equal(view._calibrationDelta, 42, "the read value should update _calibrationDelta");
});
