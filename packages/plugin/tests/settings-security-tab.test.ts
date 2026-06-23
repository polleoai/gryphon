const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const stubPath = require.resolve("./_stubs/obsidian.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};
const { _el, _allCreated } = require("./_stubs/obsidian.ts");
const { renderGryphonSettings } = require("../src/settings-view");

// Simulate the plugin's display() assembly: pass a Security extraTab and assert
// it renders as the last tab (3rd, after Models + Advanced) and its render
// callback receives a ctx.
test("plugin-style extraTabs injects a Security tab as the last tab", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const c = _el();
  let ctxSeen = null;
  renderGryphonSettings(host, c, {
    extraTabs: [{
      id: "security",
      label: "Security",
      render: (panel, ctx) => { ctxSeen = ctx; panel.createDiv("sec-body"); },
    }],
  });
  const labels = _allCreated(c).filter((x) => x.cls === "gryphon-settings-tab").map((x) => x.text);
  assert.deepEqual(labels, ["Models", "Advanced", "Security"]);
  assert.ok(ctxSeen && typeof ctxSeen.rerenderSelf === "function",
    "Security render must receive a ctx with rerenderSelf");
});
