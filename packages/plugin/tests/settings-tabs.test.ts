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
const { renderTabbedSettings } = require("../src/settings-tabs");

const tabButtons = (c) => _allCreated(c).filter((x) => x.cls === "gryphon-settings-tab");
const panels = (c) => _allCreated(c).filter((x) => x.cls === "gryphon-settings-panel");

test("renders one button + one panel per tab, first active by default", () => {
  const c = _el();
  renderTabbedSettings(c, [
    { id: "a", label: "A", render: (p) => p.createDiv("body-a") },
    { id: "b", label: "B", render: (p) => p.createDiv("body-b") },
  ]);
  assert.equal(tabButtons(c).length, 2);
  assert.equal(panels(c).length, 2);
  assert.equal(panels(c)[0].el.classList.contains("is-active"), true);
  assert.equal(panels(c)[1].el.classList.contains("is-active"), false);
});

test("clicking a tab button activates its panel and fires onTabChange", () => {
  const c = _el();
  let changed = null;
  const handle = renderTabbedSettings(c, [
    { id: "a", label: "A", render: (p) => p.createDiv("body-a") },
    { id: "b", label: "B", render: (p) => p.createDiv("body-b") },
  ], { onTabChange: (id) => { changed = id; } });
  handle.activate("b");
  assert.equal(changed, "b");
  assert.equal(panels(c)[1].el.classList.contains("is-active"), true);
  assert.equal(panels(c)[0].el.classList.contains("is-active"), false);
});

test("initialTabId selects a non-first tab", () => {
  const c = _el();
  renderTabbedSettings(c, [
    { id: "a", label: "A", render: (p) => p.createDiv("body-a") },
    { id: "b", label: "B", render: (p) => p.createDiv("body-b") },
  ], { initialTabId: "b" });
  assert.equal(panels(c)[1].el.classList.contains("is-active"), true);
  assert.equal(panels(c)[0].el.classList.contains("is-active"), false);
});

test("ctx.rerenderSelf re-renders only its panel", () => {
  const c = _el();
  let aRenders = 0, bRenders = 0;
  let ctxA;
  renderTabbedSettings(c, [
    { id: "a", label: "A", render: (p, ctx) => { aRenders++; ctxA = ctx; } },
    { id: "b", label: "B", render: () => { bRenders++; } },
  ]);
  assert.equal(aRenders, 1);
  assert.equal(bRenders, 1);
  ctxA.rerenderSelf();
  assert.equal(aRenders, 2);
  assert.equal(bRenders, 1, "rerenderSelf must NOT re-render sibling panels");
});
