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
export {};
