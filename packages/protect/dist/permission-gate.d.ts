/**
 * @param {object} args
 *   ctx       — { permissionMode, plugin, vaultRoot, ... }
 *   action    — short verb: "write", "edit", "delete", "run"
 *   target    — file path (or command preview) the action affects
 *   detail    — optional preview body shown in the modal (diff, content)
 *
 * @returns {Promise<{allow: boolean, reason: string}>}
 */
declare function checkPermission({ ctx, action, target, detail, cacheable, kind, warning, category, categoryTitle, fixedInvariant, }: {
    ctx: Record<string, unknown>;
    action: string;
    target: string;
    detail?: string | null;
    cacheable?: boolean;
    kind?: string;
    warning?: string | null;
    category?: string | null;
    categoryTitle?: string | null;
    fixedInvariant?: boolean;
}): Promise<{
    allow: boolean;
    reason: string;
}>;
declare function setActiveProviderKindResolver(fn: ((plugin: unknown) => string | null) | null): void;
/**
 * Obsidian's Modal and Setting, registered by the host's UI code (the plugin
 * package registers them on load). protect never loads "obsidian" itself:
 * the package must load with no obsidian installed (headless contract, #26;
 * enforced by scripts/pack-verify.sh check f).
 */
interface PermissionModalUi {
    Modal: typeof import("obsidian").Modal;
    Setting: typeof import("obsidian").Setting;
}
declare function setPermissionModalUi(ui: PermissionModalUi | null): void;
export { checkPermission, setActiveProviderKindResolver, setPermissionModalUi };
