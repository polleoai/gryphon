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
const { renderAdvancedPanel } = require("../src/settings-view");

const noopCtx = { rerenderSelf() {}, rerenderAll() {} };
const find = (p, name) => _allSettings(p).find((s) => s.name === name);
const names = (p) => _allSettings(p).map((s) => s.name);

test("renders all Advanced rows", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const panel = _el();
  renderAdvancedPanel(host, panel, noopCtx);
  const n = names(panel);
  for (const f of [
    "Brave Search API key", "Auto-compact at 95% (SDK mode)",
    "Auto-retry on rate-limit", "Use exact token counts (SDK mode)",
    "Confirm before overflow sends", "Block Obsidian REST API access",
    "Connection timeout (seconds)", "Max file size (MB)",
  ]) {
    assert.ok(n.includes(f), `missing ${f}`);
  }
});

test("Block REST toggle still fires gryphon:settings-changed", async () => {
  let fired = null;
  const host = {
    settings: { obsidianRestApiPolicy: "blocked" },
    saveSettings: async () => {},
    app: { workspace: { trigger: (ev) => { fired = ev; } } },
  };
  const panel = _el();
  renderAdvancedPanel(host, panel, noopCtx);
  const row = find(panel, "Block Obsidian REST API access");
  const toggle = row.controls.find((c) => c.type === "toggle");
  await toggle.changeHandler(false);
  assert.equal(host.settings.obsidianRestApiPolicy, "allowed");
  assert.equal(fired, "gryphon:settings-changed");
});
