declare const KIND = "antigravity-cli";
/**
 * Issue #30 store-guard-only mode: the hook runs the materialized store-guard
 * script with no IPC socket, so ownership of the shared key (for the
 * multi-vault cleanup guard) is a per-spawn random token instead.
 */
type StoreGuardOnly = {
    scriptPath: string;
    approvalsDir: string;
};
/**
 * Top-level key we own inside the shared hooks.json. Antigravity keys hook
 * specs by name and merges across names, so this is our whole footprint.
 */
declare const HOOK_KEY = "gryphon";
/**
 * Issue #30: store-guard-only installs use their OWN key. Two Obsidian
 * windows share hooks.json; if a Protected-Mode-off spawn replaced the
 * full-mode key, another window's live turn would drop from full gating to
 * the store guard mid-reply. Antigravity merges handlers across keys, so
 * both run and a deny from either blocks the tool.
 */
declare const STORE_GUARD_HOOK_KEY = "gryphon-store-guard";
/**
 * The one location `agy` reads hooks from (see header). Not configurable.
 */
declare function hooksFilePath(): string;
declare function _asciiForShim(p: string, shortOf?: (p: string) => string | null): string | null;
declare function lastRefusal(): string | null;
/**
 * Build the hook spec stored under our key.
 *
 * Timeout is in SECONDS. Antigravity's embedded docs: "Execution timeout in
 * seconds. Defaults to 30." This differs from Gemini, whose identically
 * named field is milliseconds — copying Gemini's `* 1000` here would set a
 * multi-day timeout, and taking Antigravity's 30s default would fire a
 * default-allow long before a user finishes reading the approve/deny modal
 * (the exact bug reported against Gemini on 2026-05-03).
 */
declare function _buildHookEntry({ pluginDir, nodePath, ipcSocketPath, storeGuard, owner }: {
    pluginDir?: string;
    nodePath: string;
    ipcSocketPath?: string;
    storeGuard?: StoreGuardOnly;
    owner?: string;
}): {
    PreToolUse: {
        matcher: string;
        hooks: {
            type: string;
            command: string;
            timeout: number;
        }[];
    }[];
} | null;
/**
 * Recover the IPC socket baked into an installed hook entry, so cleanup can
 * tell "the key I installed" from "a key another vault installed after me".
 */
declare function _socketOf(entry: unknown): string | null;
/**
 * Merge our key into `file`. Exported unbound from the real path so tests
 * never touch the user's global config.
 */
declare function _installInto(file: string, { pluginDir, nodePath, ipcSocketPath, storeGuard, owner }: {
    pluginDir?: string;
    nodePath: string;
    ipcSocketPath?: string;
    storeGuard?: StoreGuardOnly;
    owner?: string;
}, key?: string): boolean;
/**
 * Remove ONLY our key. Deletes the file when our key was its sole content, so
 * an install/uninstall cycle is a true no-op on the user's config.
 *
 * `ownedSocket` guards the multi-vault case. Two Obsidian windows share this
 * one file: vault B's spawn overwrites the key with B's socket, then vault A
 * finishes and cleans up. A blind delete would strip B's guardrail mid-turn,
 * leaving a provider running with auto-approve and nothing gating it. So a
 * per-spawn cleanup only removes the key if it is still the one it installed.
 * Pass nothing to force removal (self-heal path).
 */
declare function _uninstallFrom(file: string, ownedSocket?: string, key?: string): boolean;
/**
 * Self-heal: drop a key left behind by a crash. Identical mechanics to
 * uninstall; named separately because the intent (and the logging) differ —
 * this one runs when we do NOT expect to own the key.
 */
declare function _stripStaleFrom(file: string, key?: string): boolean;
/** Public self-heal entry point — call on plugin load. */
declare function stripStaleHooks(): boolean;
/**
 * Adapter contract — see hook-dispatcher.ts.
 *
 * Unlike the other adapters this adds no CLI args: `agy` has no flag that
 * points at a hooks file, so installation IS the wiring.
 *
 * @param _hooksFile test seam — overrides the global path.
 */
declare function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, storeGuardOnly, _hooksFile }: {
    pluginDir?: string;
    ipcSocketPath?: string;
    nodePath: string;
    storeGuardOnly?: StoreGuardOnly;
    _hooksFile?: string;
}): {
    env: {
        GRYPHON_HOOK_PROVIDER: string;
        GRYPHON_PERMISSION_SOCKET?: undefined;
        GRYPHON_HOOK_DIALECT?: undefined;
    };
    args: never[];
    cleanup: () => void;
    hooksFile: string;
} | {
    env: {
        GRYPHON_PERMISSION_SOCKET: string;
        GRYPHON_HOOK_DIALECT: string;
        GRYPHON_HOOK_PROVIDER: string;
    };
    args: never[];
    cleanup: () => void;
    hooksFile: string;
} | null;
export { KIND as kind, buildSpawnExtras, hooksFilePath, stripStaleHooks, HOOK_KEY, STORE_GUARD_HOOK_KEY, _buildHookEntry, _socketOf, _installInto, _uninstallFrom, _stripStaleFrom, _asciiForShim, lastRefusal, };
