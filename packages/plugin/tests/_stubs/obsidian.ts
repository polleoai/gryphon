/**
 * Minimal `obsidian` module stub for unit tests.
 *
 * Real Obsidian provides these classes at runtime; in tests we just need
 * enough surface so that `require("obsidian")` succeeds. Tool tests run
 * in `bypassPermissions` mode so the Modal is never constructed.
 *
 * Recording upgrade (issue #14): `Setting` now records `setName()` plus each
 * `addText`/`addDropdown`/`addToggle`/`addButton` component (its last
 * `setValue` and captured `onChange`), and registers itself on the container
 * it was constructed with. `_el()` records the `createDiv`/`createEl`/
 * `createSpan` calls made on it. Together these let settings-rendering code
 * be unit-tested headlessly: a test builds a recording container, calls the
 * renderer, then enumerates `container.__settings` (the rows that were drawn)
 * and `container.__created` (the chrome elements that were drawn).
 */

class Modal {
  constructor() { this.titleEl = _el(); this.contentEl = _el(); }
  open() {}
  close() {}
}

// One captured component (text input / dropdown / toggle / button) inside a
// Setting row. `value` is the last `setValue`; `changeHandler` is the last
// `onChange` callback so a test can drive it directly.
function _control(type) {
  const c = {
    type,
    value: undefined,
    placeholder: undefined,
    options: [],
    disabled: false,
    changeHandler: null,
    clickHandler: null,
    inputEl: { type: "" },
    selectEl: _el(),   // DropdownComponent.selectEl — a recording element so
                       // class toggles (e.g. error styling) are observable
    setPlaceholder(p) { c.placeholder = p; return c; },
    setValue(v) { c.value = v; return c; },
    setDisabled(d) { c.disabled = d; return c; },
    setButtonText(t) { c.buttonText = t; return c; },
    setTooltip() { return c; },
    setCta() { return c; },
    setIcon() { return c; },
    addOption(id, label) { c.options.push({ id, label }); return c; },
    onChange(fn) { c.changeHandler = fn; return c; },
    onClick(fn) { c.clickHandler = fn; return c; },
  };
  return c;
}

class Setting {
  constructor(containerEl) {
    this.name = "";
    this.controls = [];
    this.nameEl = _el();
    this.descEl = _el();
    this.settingEl = _el();
    // Register on the container so tests can enumerate the rows that were
    // drawn into it (in render order).
    if (containerEl && Array.isArray(containerEl.__settings)) {
      containerEl.__settings.push(this);
    }
  }
  setName(name) { this.name = typeof name === "string" ? name : ""; return this; }
  setDesc() { return this; }
  setClass() { return this; }
  setHeading() { return this; }
  addText(fn) { const c = _control("text"); fn(c); this.controls.push(c); return this; }
  addTextArea(fn) { const c = _control("textarea"); fn(c); this.controls.push(c); return this; }
  addDropdown(fn) { const c = _control("dropdown"); fn(c); this.controls.push(c); return this; }
  addToggle(fn) { const c = _control("toggle"); fn(c); this.controls.push(c); return this; }
  addButton(fn) { const c = _control("button"); fn(c); this.controls.push(c); return this; }
  addExtraButton(fn) { const c = _control("button"); fn(c); this.controls.push(c); return this; }
  then(fn) { if (fn) fn(this); return this; }
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

// Recording element factory. Beyond the original `setText`/`createEl`/`style`
// surface, the returned element captures the children it creates (in
// `__created`, each `{ tag, cls, text, el }`) and accumulates Settings built
// against it (in `__settings`). Sub-elements are themselves recording
// elements, so chrome built into nested containers is still observable.
// Class tracking is now real: classList/addClass/removeClass/toggleClass/
// className all mutate a backing Set so tests can assert `is-active` toggling.
function _el() {
  const _classes = new Set<string>();
  const el: any = {
    __settings: [],
    __created: [],
    style: {},
    get className() { return [..._classes].join(" "); },
    set className(v) {
      _classes.clear();
      String(v || "").split(/\s+/).filter(Boolean).forEach((c) => _classes.add(c));
    },
    classList: {
      add(...cs: string[]) { cs.forEach((c) => _classes.add(c)); },
      remove(...cs: string[]) { cs.forEach((c) => _classes.delete(c)); },
      toggle(c: string, force?: boolean) {
        const want = force === undefined ? !_classes.has(c) : force;
        if (want) _classes.add(c); else _classes.delete(c);
        return want;
      },
      contains(c: string) { return _classes.has(c); },
    },
    setText() { return el; },
    setAttr() { return el; },
    setAttribute() { return el; },
    empty() { el.__created.length = 0; el.__settings.length = 0; return el; },
    addClass(c: string) { _classes.add(c); return el; },
    removeClass(c: string) { _classes.delete(c); return el; },
    toggleClass(c: string, force?: boolean) {
      const want = force === undefined ? !_classes.has(c) : force;
      if (want) _classes.add(c); else _classes.delete(c);
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
    setCssStyles(obj: any) { if (obj) Object.assign(el.style, obj); return el; },
    setTooltip() { return el; },
    appendChild() {},
    createEl(tag: string, opts?: any) {
      const child = _el();
      el.__created.push({ tag, cls: opts && opts.cls, text: opts && opts.text, attr: opts && opts.attr, el: child });
      return child;
    },
    createDiv(arg?: any) {
      const child = _el();
      el.__created.push({
        tag: "div",
        cls: typeof arg === "string" ? arg : (arg && arg.cls),
        text: (arg && typeof arg === "object") ? arg.text : undefined,
        attr: (arg && typeof arg === "object") ? arg.attr : undefined,
        el: child,
      });
      return child;
    },
    createSpan(opts?: any) {
      const child = _el();
      el.__created.push({ tag: "span", cls: opts && opts.cls, text: opts && opts.text, attr: opts && opts.attr, el: child });
      return child;
    },
  };
  return el;
}

function _allSettings(el: any): any[] {
  if (!el) return [];
  const out = [...(el.__settings || [])];
  for (const c of el.__created || []) {
    if (c && c.el) out.push(..._allSettings(c.el));
  }
  return out;
}

function _allCreated(el: any): any[] {
  if (!el) return [];
  const out = [...(el.__created || [])];
  for (const c of el.__created || []) {
    if (c && c.el) out.push(..._allCreated(c.el));
  }
  return out;
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
    this.containerEl = _el();
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
  // Test helpers: the recording element factory + recursive collectors.
  // _el() builds a recording container; _allSettings/_allCreated recurse into
  // child elements created via createDiv/createEl/createSpan.
  _el, _allSettings, _allCreated,
};
