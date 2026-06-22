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

const obsidian = require("./_stubs/obsidian.js");
const { renderGryphonSettings } = require("../src/settings-view");

const makeContainer = () => obsidian._el();
const findRow = (container, name) =>
  container.__settings.find((s) => s.name === name);
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

test("chrome:false suppresses the quick-start callout; default chrome renders it", () => {
  const host = { settings: {}, saveSettings: async () => {} };

  const withChrome = makeContainer();
  renderGryphonSettings(host, withChrome);
  assert.ok(
    withChrome.__created.some((c) => c.cls === "gryphon-setting-callout"),
    "default chrome should render the quick-start callout",
  );

  const noChrome = makeContainer();
  renderGryphonSettings(host, noChrome, { chrome: false });
  assert.ok(
    noChrome.__created.every((c) => c.cls !== "gryphon-setting-callout"),
    "chrome:false should omit the quick-start callout",
  );
});
