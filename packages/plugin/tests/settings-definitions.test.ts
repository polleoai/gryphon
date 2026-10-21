/**
 * #39: Obsidian 1.13+ renders a settings tab from getSettingDefinitions() and
 * then never calls display(). Gryphon hosts its tabbed UI in one render item
 * whose aliases feed the settings search; older Obsidian keeps using display().
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.ts");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return origResolve.call(this, request, ...args);
};
const obsidian = require("./_stubs/obsidian.ts");
const GryphonPlugin = require("../src/plugin");
const SettingTab = GryphonPlugin.SettingTab;

function makeTab() {
  const tab = new SettingTab({}, { settings: {} });
  const rendered: unknown[] = [];
  tab._renderInto = (el: unknown) => { rendered.push(el); };
  return { tab, rendered };
}

test("#39: one render item named Gryphon whose aliases cover the settings", () => {
  const { tab } = makeTab();
  const defs = tab.getSettingDefinitions();
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, "Gryphon");
  assert.equal(typeof defs[0].render, "function");
  for (const term of ["Protected Mode", "Permission mode", "Default model", "Claude Code path", "Anthropic API key", "Security"]) {
    assert.ok(defs[0].aliases.includes(term), `aliases include ${term}`);
  }
  assert.equal("control" in defs[0], false, "no control definitions: security writes stay on the machine store");
});

test("#39: the render item hosts the settings UI in the row it is given", () => {
  const { tab, rendered } = makeTab();
  const settingEl = obsidian._el();
  settingEl.className = "setting-item";
  let emptied = false;
  settingEl.empty = () => { emptied = true; };
  tab.getSettingDefinitions()[0].render({ settingEl });
  assert.ok(emptied, "the row's own name/control markup is cleared");
  assert.equal(settingEl.className, "gryphon-settings-host");
  assert.deepEqual(rendered, [settingEl]);
});

test("#39: refresh() re-evaluates the definitions on 1.13+, re-renders containerEl before", () => {
  const { tab, rendered } = makeTab();
  let updates = 0;
  tab.update = () => { updates++; };
  const real = obsidian.requireApiVersion;
  try {
    obsidian.requireApiVersion = () => true;
    tab.refresh();
    assert.equal(updates, 1);
    assert.deepEqual(rendered, []);
    obsidian.requireApiVersion = () => false;
    tab.refresh();
    assert.deepEqual(rendered, [tab.containerEl]);
  } finally {
    obsidian.requireApiVersion = real;
  }
});

test("#39: display() (Obsidian before 1.13) renders into containerEl", () => {
  const { tab, rendered } = makeTab();
  tab.display();
  assert.deepEqual(rendered, [tab.containerEl]);
});
