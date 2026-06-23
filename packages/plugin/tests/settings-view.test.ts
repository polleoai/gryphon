/**
 * settings-view.test.ts — acceptance tests for issue #14.
 *
 * `renderGryphonSettings(hostPlugin, containerEl, options?)` is the shared,
 * host-agnostic renderer for Gryphon's portable config zone (Provider +
 * Defaults). It exists so embedding consumers stop hand-mirroring
 * `new Setting(...)` rows and dropping fields — the bug class that left the
 * Anthropic/OpenAI/Google API-key inputs unrenderable from the host.
 *
 * These tests run headlessly against the recording obsidian stub: a recording
 * container records every Setting row built into it and every chrome element
 * created, so we can assert the field set and drive an onChange directly.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Inject the obsidian stub the same way every other plugin unit test does.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { _el, _allSettings, _allCreated } = require("./_stubs/obsidian.ts");
const { renderGryphonSettings } = require("../src/settings-view");

const makeContainer = () => _el();
const findRow = (container, name) =>
  _allSettings(container).find((s) => s.name === name);
const textControl = (setting) =>
  setting && setting.controls.find((c) => c.type === "text");

test("renders Provider, Default model, and all three API-key rows for a minimal host", () => {
  // Minimal duck type — exactly the contract the issue promises.
  const host = { settings: {}, saveSettings: async () => {} };
  const container = makeContainer();

  renderGryphonSettings(host, container);

  for (const name of [
    "Provider",
    "Default model",
    "Anthropic API key",
    "OpenAI API key",
    "Google API key",
  ]) {
    assert.ok(
      findRow(container, name),
      `expected a settings row named "${name}" — its absence is the consumer drift bug`,
    );
  }
});

test("driving the Google-key onChange writes settings + calls saveSettings (closes the consumer drift bug class)", async () => {
  let saved = false;
  const host = {
    settings: { providerPreference: "google-api" },
    saveSettings: async () => { saved = true; },
  };
  const container = makeContainer();

  renderGryphonSettings(host, container);

  const row = findRow(container, "Google API key");
  assert.ok(row, "Google API key row must exist");
  const ctl = textControl(row);
  assert.ok(
    ctl && typeof ctl.changeHandler === "function",
    "Google API key row must capture an onChange handler",
  );

  await ctl.changeHandler("AIzaSyTEST");

  assert.equal(host.settings.googleApiKey, "AIzaSyTEST");
  assert.equal(saved, true, "saveSettings() must fire on key change");
});

test("no quick-start callout is rendered (removed)", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const c = makeContainer();
  renderGryphonSettings(host, c);
  assert.ok(
    _allCreated(c).every((x) => x.cls !== "gryphon-setting-callout"),
    "the quick-start callout was removed and must not render",
  );
});

test("renders a tab bar with Models/Advanced (no extraTabs)", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const c = makeContainer();
  renderGryphonSettings(host, c);
  const tabLabels = _allCreated(c)
    .filter((x) => x.cls === "gryphon-settings-tab")
    .map((x) => x.text);
  assert.deepEqual(tabLabels, ["Models", "Advanced"]);
});

test("Models tab combines provider (Setup) + Default model (Defaults)", () => {
  const host = { settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" }, saveSettings: async () => {} };
  const c = makeContainer();
  renderGryphonSettings(host, c);
  const names = _allSettings(c).map((s) => s.name);
  assert.ok(names.includes("Provider"), "Models tab holds the Setup provider row");
  assert.ok(names.includes("Default model"), "Models tab holds the Defaults model row");
});

test("Models tab outlines Model and Fallback as two distinct groups", () => {
  const host = { settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" }, saveSettings: async () => {} };
  const c = makeContainer();
  renderGryphonSettings(host, c);
  const groups = _allCreated(c).filter((x) => x.cls === "gryphon-settings-group");
  assert.equal(groups.length, 2, "two outlined groups: Model + Fallback");
  const namesIn = (g) => _allSettings(g.el).map((s) => s.name);
  const modelNames = namesIn(groups[0]);
  const fbNames = namesIn(groups[1]);
  assert.ok(modelNames.includes("Provider"), "Model group holds Provider");
  assert.ok(modelNames.includes("Default model"), "Model group holds Default model");
  assert.ok(!modelNames.includes("Fallback provider"), "Fallback is NOT inside the Model group");
  assert.ok(fbNames.includes("Fallback provider"), "Fallback group holds Fallback provider");
});

test("Fallback renders AFTER the default-model settings in the Models tab", () => {
  const host = { settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" }, saveSettings: async () => {} };
  const c = makeContainer();
  renderGryphonSettings(host, c);
  const names = _allSettings(c).map((s) => s.name);
  const iProvider = names.indexOf("Provider");
  const iDefaultModel = names.indexOf("Default model");
  const iFallback = names.indexOf("Fallback provider");
  assert.ok(iProvider >= 0 && iDefaultModel >= 0 && iFallback >= 0, "all three rows present");
  assert.ok(iFallback > iDefaultModel, "Fallback provider must come after Default model");
  assert.ok(iDefaultModel > iProvider, "Default model still after Provider");
});

test("options.extraTabs appends a third tab (Security)", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const c = makeContainer();
  let gotPanel = false;
  renderGryphonSettings(host, c, {
    extraTabs: [{ id: "security", label: "Security", render: () => { gotPanel = true; } }],
  });
  const tabLabels = _allCreated(c)
    .filter((x) => x.cls === "gryphon-settings-tab")
    .map((x) => x.text);
  assert.deepEqual(tabLabels, ["Models", "Advanced", "Security"]);
  assert.equal(gotPanel, true, "extraTabs render callback must run");
});
