const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const stubPath = require.resolve("./_stubs/obsidian.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};
const { _el, _allSettings } = require("./_stubs/obsidian.ts");
const { renderDefaultsPanel } = require("../src/settings-view");

const noopCtx = { rerenderSelf() {}, rerenderAll() {} };
const names = (p) => _allSettings(p).map((s) => s.name);

test("renders Default model, effort, permissions, open-in-main-tab", () => {
  const host = { settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" },
                 saveSettings: async () => {} };
  const panel = _el();
  renderDefaultsPanel(host, panel, noopCtx);
  const n = names(panel);
  for (const f of ["Default model", "Default effort", "Default permissions", "Open in main tab"]) {
    assert.ok(n.includes(f), `missing ${f}`);
  }
});

test("does NOT render provider credential or tuning rows", () => {
  const host = { settings: { providerPreference: "anthropic-api", model: "claude-sonnet-4-6" },
                 saveSettings: async () => {} };
  const panel = _el();
  renderDefaultsPanel(host, panel, noopCtx);
  const n = names(panel);
  assert.ok(!n.includes("Anthropic API key"));
  assert.ok(!n.includes("Connection timeout (seconds)"));
});
