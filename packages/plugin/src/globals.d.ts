// Ambient declarations for Obsidian runtime globals.
//
// Obsidian injects `activeDocument` and `activeWindow` (declared by
// obsidian.d.ts since 1.13) so plugin code stays correct when a view is torn
// out into a popout window. It also installs its DOM helpers — createEl,
// createDiv, createSpan — on EVERY window, so `activeWindow.createDiv()`
// creates the element in the focused window's document (what
// obsidianmd/prefer-create-el recommends for detached elements). obsidian.d.ts
// declares those helpers as globals but not on `Window`; say so here.
// Renderer-only — never reference these from headless hook scripts, where no
// window exists.

declare global {
  interface Window {
    createEl: typeof createEl;
    createDiv: typeof createDiv;
    createSpan: typeof createSpan;
    createFragment: typeof createFragment;
  }
}

export {};
