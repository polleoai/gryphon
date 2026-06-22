// Ambient declarations for Obsidian runtime globals.
//
// Obsidian injects `activeDocument` and `activeWindow` as globals so plugin
// code stays correct when a view is torn out into a popout window (they point
// at the focused window's document/window rather than the main one). The
// bundled `obsidian.d.ts` (1.13.x) does not declare them, so the
// `obsidianmd/prefer-active-doc` / `prefer-window-timers` fixes would otherwise
// fail to type-check. Declare them here. Renderer-only — never reference these
// from headless hook scripts, where no window exists.

declare global {
  const activeDocument: Document;
  const activeWindow: Window & typeof globalThis;
}

export {};
