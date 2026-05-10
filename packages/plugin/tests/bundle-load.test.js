/**
 * Bundle load smoke test.
 *
 * Obsidian loads a plugin by requiring the built `main.js` into its
 * Electron renderer. If any top-level require (e.g. `require("undici")`)
 * doesn't resolve there, the plugin crashes at load with "failed to
 * load plugin". Our unit tests historically couldn't catch this because
 * they import source files directly — they never exercised the bundled
 * output.
 *
 * This test loads `main.js` under Node with a realistic Obsidian stub
 * so any missing runtime dependency shows up as a test failure before
 * release.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const MAIN_JS = path.resolve(__dirname, "..", "main.js");

// Skip cleanly if main.js isn't built — CI should run `npm run build`
// before `npm test`, but a local dev-mode run without a fresh build
// shouldn't make this file blow up the whole suite.
const shouldSkip = !fs.existsSync(MAIN_JS)
  ? { skip: "main.js not built — run `npm run build` first" }
  : {};

test("main.js loads under a realistic Obsidian stub", shouldSkip, () => {
  // Full enough Obsidian surface to satisfy every class extension / call
  // in plugin.js, chat-view.js, skills.js, etc.
  const obsidianStub = {
    Plugin: class {
      constructor() {}
      async loadData() { return null; }
      async saveData() {}
      addSettingTab() {}
      addRibbonIcon() {}
      registerView() {}
      addCommand() {}
      registerEvent() {}
    },
    PluginSettingTab: class {
      constructor(app, plugin) { this.app = app; this.plugin = plugin; }
      display() {}
    },
    Setting: class {
      constructor() {}
      setName() { return this; }
      setDesc() { return this; }
      addText(fn) { if (fn) fn(this); return this; }
      addToggle(fn) { if (fn) fn({ setValue() { return this; }, onChange() { return this; } }); return this; }
      addDropdown(fn) { if (fn) fn({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
      addButton(fn) { if (fn) fn({ setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } }); return this; }
      addTextArea(fn) {
        const el = { rows: 0, style: {} };
        const h = { setPlaceholder() { return h; }, setValue() { return h; }, onChange() { return h; }, inputEl: el };
        if (fn) fn(h);
        return this;
      }
    },
    Modal: class {
      constructor() {
        const el = { setText() {}, createEl() { return el; }, style: {} };
        this.titleEl = el;
        this.contentEl = el;
      }
      open() {}
      close() {}
    },
    Notice: class {},
    TFile: class {},
    TFolder: class {},
    ItemView: class { constructor() {} },
    MarkdownView: class {},
    FileSystemAdapter: class {},
    normalizePath: (p) => p,
    Platform: { isDesktop: true, isMobile: false },
    setTooltip: () => {},  // Obsidian's helper; no-op for tests
  };

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...args) {
    if (req === "obsidian") return "obsidian-stub";
    return origResolve.call(this, req, ...args);
  };
  require.cache["obsidian-stub"] = {
    id: "obsidian-stub",
    filename: "obsidian-stub",
    exports: obsidianStub,
    loaded: true,
    children: [],
    paths: [],
  };

  try {
    // Bust module cache in case a previous test required a source file
    // that's now aliased into main.js via the bundle.
    delete require.cache[MAIN_JS];
    require(MAIN_JS);
  } catch (e) {
    assert.fail(
      `main.js failed to load under Obsidian-like runtime:\n${e.message}\n\n${e.stack}`,
    );
  } finally {
    Module._resolveFilename = origResolve;
    delete require.cache["obsidian-stub"];
    delete require.cache[MAIN_JS];
  }
});
