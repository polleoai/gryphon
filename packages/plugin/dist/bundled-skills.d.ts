/**
 * Bundled skill content shipped with Gryphon. On first plugin load (or any
 * load where a bundled file is missing), the skill loader writes each of
 * these into the vault under Gryphon/Skills/. Existing files are never
 * overwritten — user customizations are preserved across upgrades.
 *
 * Editing a bundled skill in the vault takes effect on next invocation
 * (hot reload via vault events). Deleting a bundled skill removes it
 * from autocomplete; it will be recreated on the next plugin reload
 * (we don't track a seen-list in v1).
 */
export {};
