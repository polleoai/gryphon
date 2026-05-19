/**
 * F1 Stage D (v1.7.0) — self-tuning projection calibration.
 *
 * Verifies the rolling-buffer + mean math on the plugin helpers
 * `recordProjectionCalibrationSample` + `getProjectionCalibrationDelta`.
 * The full chat-view integration (observe actual, compare to projected,
 * record) is exercised by manual QA — these tests pin the pure logic.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Minimal stand-in for a GryphonPlugin that exposes ONLY the two
// calibration methods we want to exercise. We extract them from the
// real prototype to keep the tests honest if the implementation moves.
function loadPluginPrototype() {
  // Stub Obsidian + worker dependencies the plugin's top-level requires
  // pull in. We never instantiate the plugin proper — we just lift the
  // two prototype methods. Path is required relative so node's module
  // cache resolves at test time, not bundle time.
  const Module = require("module");
  const origLoad = Module._load;
  // Stub obsidian with the minimum surface plugin.js + chat-view.js touch
  // at module load time. ItemView / Plugin / Modal are class-extended;
  // every other helper is just called, so a no-op function suffices.
  class StubBase { constructor() {} registerEvent() {} addCommand() {} addRibbonIcon() {} addStatusBarItem() {} addSettingTab() {} loadData() { return {}; } saveData() {} app = {}; settings = {}; }
  const noop = () => undefined;
  const obsidianStub = {
    Plugin: StubBase,
    ItemView: StubBase,
    Modal: StubBase,
    PluginSettingTab: StubBase,
    Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } addExtraButton() { return this; } addSlider() { return this; } addTextArea() { return this; } then() { return this; } },
    MarkdownRenderer: { render: noop, renderMarkdown: noop },
    MarkdownView: class {},
    Notice: class { constructor() {} },
    Menu: class { constructor() {} addItem() { return this; } showAtMouseEvent() {} },
    setTooltip: noop,
    requestUrl: async () => ({ status: 200, text: "" }),
    debounce: (fn) => fn,
    TFile: class {},
    TFolder: class {},
    normalizePath: (p) => p,
    Platform: { isDesktop: true, isMobile: false },
  };
  Module._load = function (request, ...rest) {
    if (request === "obsidian") return obsidianStub;
    return origLoad.call(this, request, ...rest);
  };
  let GryphonPlugin;
  try {
    ({ default: GryphonPlugin } = (() => {
      // The plugin export is `module.exports = GryphonPlugin` (default-style).
      const mod = require("../src/plugin");
      return { default: mod };
    })());
  } finally {
    Module._load = origLoad;
  }
  return GryphonPlugin;
}

function makeHarness() {
  // We don't need the real plugin's onload — only the methods. Create a
  // plain object with `this.settings` mutable and `this.saveData` a
  // no-op, then bind the prototype methods to it.
  const Plugin = loadPluginPrototype();
  const harness = {
    settings: {},
    saveData: async () => {},
  };
  harness.recordProjectionCalibrationSample = Plugin.prototype.recordProjectionCalibrationSample.bind(harness);
  harness.getProjectionCalibrationDelta = Plugin.prototype.getProjectionCalibrationDelta.bind(harness);
  return harness;
}

test("getProjectionCalibrationDelta returns 0 on a fresh vault", () => {
  const h = makeHarness();
  assert.equal(h.getProjectionCalibrationDelta(), 0);
});

test("recordProjectionCalibrationSample appends to buffer", () => {
  const h = makeHarness();
  h.recordProjectionCalibrationSample(100);
  h.recordProjectionCalibrationSample(200);
  h.recordProjectionCalibrationSample(300);
  assert.deepEqual(h.settings._projectionCalibrationDeltas, [100, 200, 300]);
});

test("getProjectionCalibrationDelta returns the rounded mean", () => {
  const h = makeHarness();
  h.recordProjectionCalibrationSample(100);
  h.recordProjectionCalibrationSample(200);
  h.recordProjectionCalibrationSample(300);
  // Mean of 100,200,300 = 200
  assert.equal(h.getProjectionCalibrationDelta(), 200);
});

test("buffer caps at 20 — oldest entries fall off", () => {
  const h = makeHarness();
  for (let i = 1; i <= 25; i++) {
    h.recordProjectionCalibrationSample(i * 10);
  }
  // After 25 samples (10, 20, …, 250), only the last 20 remain:
  // 60, 70, …, 250
  const buf = h.settings._projectionCalibrationDeltas;
  assert.equal(buf.length, 20);
  assert.equal(buf[0], 60);
  assert.equal(buf[buf.length - 1], 250);
});

test("non-finite samples are dropped at intake (not just averaging)", () => {
  // Defense in depth — if a NaN ever slips through (e.g. windowSize
  // turning 0 in a transient bad state), it must not poison the buffer.
  const h = makeHarness();
  h.recordProjectionCalibrationSample(NaN);
  h.recordProjectionCalibrationSample(Infinity);
  h.recordProjectionCalibrationSample(-Infinity);
  assert.equal(h.settings._projectionCalibrationDeltas, undefined);
});

test("getProjectionCalibrationDelta ignores any finite-bypass in stored data", () => {
  const h = makeHarness();
  // Simulate a settings file edited externally with a bad value mixed in.
  h.settings._projectionCalibrationDeltas = [100, NaN, 200, "oops", 300];
  // Only 100, 200, 300 should contribute — mean = 200.
  assert.equal(h.getProjectionCalibrationDelta(), 200);
});

test("negative samples are recorded (estimator over-counts case)", () => {
  // Self-tuning is symmetric: if the estimator routinely OVER-counts
  // (e.g. user disabled most skills but we still sum their byte cost),
  // delta is negative and the projection subtracts on the next turn.
  const h = makeHarness();
  h.recordProjectionCalibrationSample(-1000);
  h.recordProjectionCalibrationSample(-2000);
  h.recordProjectionCalibrationSample(-3000);
  assert.equal(h.getProjectionCalibrationDelta(), -2000);
});

test("recordProjectionCalibrationSample survives saveData throwing", () => {
  // saveData failures (disk full, permission, etc.) must not bubble —
  // calibration is best-effort; a chat session continues either way.
  const h = makeHarness();
  h.saveData = async () => { throw new Error("disk full"); };
  assert.doesNotThrow(() => h.recordProjectionCalibrationSample(500));
  assert.deepEqual(h.settings._projectionCalibrationDeltas, [500]);
});
