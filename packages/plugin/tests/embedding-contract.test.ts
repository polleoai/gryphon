/**
 * Issue #3 — embedding-host-plugin contract.
 *
 * GryphonChatView calls a handful of methods on `this.plugin`. Required ones
 * (saveSettings) have no safe default; optional UI hooks must degrade
 * gracefully so a consumer (an embedding host app) that embeds the view without
 * shadow-implementing Gryphon's private plugin surface doesn't throw on a
 * specific UI path.
 *
 * The reported instance: the welcome-panel "Activate provider" handler
 * (_activateProvider) called this.plugin._resetActiveSessions() and
 * this.plugin._announceProviderChange() unguarded — a consumer lacking
 * either threw when the user clicked Activate.
 *
 * Tested via direct method invocation with minimal stubs (same pattern as
 * the other chat-view unit tests).
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

test("_activateProvider does not throw when the host lacks optional hooks (consumer embed)", async () => {
  const view = Object.create(GryphonChatView.prototype);
  let saved = 0;
  let welcomeRefreshed = 0;
  // Minimal consumer plugin: implements the REQUIRED saveSettings, but NOT
  // the optional _resetActiveSessions / _announceProviderChange hooks.
  view.plugin = {
    settings: { providerPreference: "auto" },
    saveSettings: async () => { saved += 1; },
  };
  view.refreshWelcomePanel = () => { welcomeRefreshed += 1; };

  await assert.doesNotReject(view._activateProvider("anthropic-api"));

  assert.equal(view.plugin.settings.providerPreference, "anthropic-api", "preference should be persisted");
  assert.equal(saved, 1, "saveSettings should run (fires gryphon:settings-changed → teardown)");
  assert.equal(welcomeRefreshed, 1, "should fall back to refreshing this view's welcome panel so it disappears");
});

test("_activateProvider uses the host's _resetActiveSessions when present (Gryphon-as-plugin)", async () => {
  const view = Object.create(GryphonChatView.prototype);
  let reset = 0;
  let announced = null;
  let welcomeRefreshed = 0;
  view.plugin = {
    settings: { providerPreference: "auto" },
    saveSettings: async () => {},
    _resetActiveSessions: () => { reset += 1; },
    _announceProviderChange: (prev, next) => { announced = [prev, next]; },
  };
  view.refreshWelcomePanel = () => { welcomeRefreshed += 1; };

  await view._activateProvider("codex-cli");

  assert.equal(reset, 1, "host _resetActiveSessions should be used when present");
  assert.equal(welcomeRefreshed, 0, "fallback panel refresh should NOT fire when the host hook ran");
  assert.deepEqual(announced, ["auto", "codex-cli"], "provider-change announce should fire on a real switch");
});

test("_activateProvider skips _announceProviderChange when preference is unchanged", async () => {
  const view = Object.create(GryphonChatView.prototype);
  let announced = 0;
  view.plugin = {
    settings: { providerPreference: "anthropic-api" },
    saveSettings: async () => {},
    _resetActiveSessions: () => {},
    _announceProviderChange: () => { announced += 1; },
  };
  view.refreshWelcomePanel = () => {};

  await view._activateProvider("anthropic-api");

  assert.equal(announced, 0, "no announce when the provider did not actually change");
});

test("constructor warns loudly when a REQUIRED host method is missing", () => {
  const origError = console.error;
  const errors = [];
  console.error = (...a) => { errors.push(a.join(" ")); };
  try {
    // saveSettings absent → the contract is violated; surface it at
    // construction instead of throwing deep in a later UI path.
    new GryphonChatView({}, { manifest: { version: "t" }, settings: {} }, {});
  } finally {
    console.error = origError;
  }
  assert.ok(
    errors.some((e) => /saveSettings/.test(e) && /gryphon/i.test(e)),
    "should console.error naming the missing required host method saveSettings",
  );
});
