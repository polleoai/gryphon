/**
 * Bundled vault docs shipped with Gryphon. Seeded into the vault's
 * `Gryphon/` folder (parent of `Gryphon/Skills/`) on first plugin load.
 *
 * Same write-once contract as bundled-skills.js: existing files are
 * never overwritten, so user customizations survive plugin upgrades.
 * To force a refresh of the manual, the user deletes the file and
 * reloads Gryphon — the bundled copy reappears.
 *
 * The manual lives in the vault (not the plugin code directory) so it
 * shows up in Obsidian's file tree where users actually look for help.
 */
export {};
