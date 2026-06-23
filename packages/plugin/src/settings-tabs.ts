/**
 * settings-tabs.ts — content-agnostic segmented-tab renderer for the
 * settings interface. Builds a tab bar + panel host, toggles the active
 * panel via the `is-active` class, and hands each panel a re-render context.
 *
 * Returns a small handle `{ activate(id) }` so callers (and tests) can drive
 * activation programmatically. Panels render once on build; `ctx.rerenderSelf`
 * re-renders just that panel, `ctx.rerenderAll` re-renders all panels while
 * keeping the active tab.
 */

function renderTabbedSettings(containerEl, tabs, opts) {
  opts = opts || {};
  const ids = tabs.map((t) => t.id);
  let activeId = ids.includes(opts.initialTabId) ? opts.initialTabId : (ids[0] || null);

  const tabBar = containerEl.createDiv("gryphon-settings-tabs");
  const panelHost = containerEl.createDiv("gryphon-settings-panels");

  const buttons = {};
  const panelEls = {};

  const applyActive = () => {
    for (const t of tabs) {
      const on = t.id === activeId;
      buttons[t.id].toggleClass("is-active", on);
      panelEls[t.id].toggleClass("is-active", on);
    }
  };

  const ctxFor = (t) => ({
    rerenderSelf: () => {
      panelEls[t.id].empty();
      t.render(panelEls[t.id], ctxFor(t));
    },
    rerenderAll: () => {
      for (const u of tabs) {
        panelEls[u.id].empty();
        u.render(panelEls[u.id], ctxFor(u));
      }
      applyActive();
    },
  });

  const activate = (id) => {
    if (!ids.includes(id)) return;
    activeId = id;
    applyActive();
    if (typeof opts.onTabChange === "function") opts.onTabChange(id);
  };

  for (const t of tabs) {
    const btn = tabBar.createEl("button", { text: t.label, cls: "gryphon-settings-tab" });
    btn.addEventListener("click", () => activate(t.id));
    buttons[t.id] = btn;
    const panel = panelHost.createDiv("gryphon-settings-panel");
    panelEls[t.id] = panel;
    t.render(panel, ctxFor(t));
  }
  applyActive();

  return { activate };
}

module.exports = { renderTabbedSettings };
