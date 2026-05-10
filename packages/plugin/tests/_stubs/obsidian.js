/**
 * Minimal `obsidian` module stub for unit tests.
 *
 * Real Obsidian provides these classes at runtime; in tests we just need
 * enough surface so that `require("obsidian")` succeeds. Tool tests run
 * in `bypassPermissions` mode so the Modal is never constructed.
 */

class Modal {
  constructor() { this.titleEl = _el(); this.contentEl = _el(); }
  open() {}
  close() {}
}

class Setting {
  constructor() { return this; }
  setName() { return this; }
  setDesc() { return this; }
  addToggle(fn) { fn({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addButton(fn) { fn({ setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } }); return this; }
}

class TFile {}
class TFolder {}

// Minimal class stubs for chat-view's `extends ItemView` and module-
// level destructures. Pure-function tests importing a symbol from
// chat-view.js (e.g., filterMessagesForSave) need these so the
// module load succeeds; they're never instantiated.
class ItemView {
  constructor() {}
}
class MarkdownView {}
class Menu {}
const MarkdownRenderer = {
  render() { /* no-op; chat-view uses this only in DOM paths */ },
};
function setTooltip() { /* no-op */ }

function _el() {
  return {
    setText() {},
    createEl() { return _el(); },
    style: {},
  };
}

// requestUrl: Obsidian's CORS-bypassing HTTP client. Tests typically replace
// the export at runtime (`obsidianStub.requestUrl = mock`) before exercising
// modules that call it. The default returns 200 + empty json so accidental
// invocation in unrelated tests doesn't crash.
async function requestUrl() {
  return { status: 200, json: {}, text: "", headers: {} };
}

// Minimal Plugin base class stub — covers `class GryphonPlugin extends
// Plugin { ... }` at module load. Real instances are never constructed
// in tests; we only need the prototype chain to exist so the require()
// doesn't blow up at class-definition time.
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = { empty() {}, createEl() { return {}; } };
  }
  display() {}
  hide() {}
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerEvent() {}
  registerInterval() {}
  registerDomEvent() {}
  registerView() {}
  addCommand() {}
  addRibbonIcon() { return { addClass() {} }; }
  addStatusBarItem() { return document.createElement("div"); }
  addSettingTab() {}
  loadData() { return Promise.resolve({}); }
  saveData() { return Promise.resolve(); }
}

module.exports = {
  Modal, Setting, TFile, TFolder,
  ItemView, MarkdownView, Menu, MarkdownRenderer,
  Plugin, PluginSettingTab,
  setTooltip, requestUrl,
};
