const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _el, _allSettings, _allCreated, Setting } = require("./_stubs/obsidian.ts");

test("createDiv returns a recording child reachable via __created[].el", () => {
  const root = _el();
  const child = root.createDiv("panel");
  const rec = root.__created.find((c) => c.cls === "panel");
  assert.ok(rec, "createDiv records the child");
  assert.equal(rec.el, child, "the recorded child reference IS the returned element");
});

test("_allSettings collects Settings nested inside created child panels", () => {
  const root = _el();
  const panel = root.createDiv("panel");
  new Setting(panel).setName("Nested row");
  // Not registered on root directly:
  assert.equal(root.__settings.length, 0);
  // But reachable recursively:
  const found = _allSettings(root).find((s) => s.name === "Nested row");
  assert.ok(found, "_allSettings reaches into child panels");
});

test("classList tracks classes for real", () => {
  const el = _el();
  el.classList.add("is-active");
  assert.equal(el.classList.contains("is-active"), true);
  el.toggleClass("is-active", false);
  assert.equal(el.classList.contains("is-active"), false);
  el.className = "a b";
  assert.equal(el.classList.contains("b"), true);
});

test("_allCreated reaches nested chrome elements", () => {
  const root = _el();
  const panel = root.createDiv("panel");
  panel.createEl("strong", { cls: "callout" });
  const found = _allCreated(root).find((c) => c.cls === "callout");
  assert.ok(found, "_allCreated recurses into child panels");
});
