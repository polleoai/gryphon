/**
 * Run pre-flight diagnostics. Returns `{ ok, mode, reason, details,
 * nodePath, storeGuardScript? }`. `details` is the per-component breakdown
 * so a debug log can show exactly which check failed (matches the existing
 * claude-code `hookPreflight` shape).
 *
 * Protected Mode on → mode "full" (IPC + plugin dir + node). Off → mode
 * "store-guard-only": node + a verified store-guard script, and nothing
 * else — `ipcServer` and `absolutePluginDir` are not consulted.
 */
declare function _preflight(plugin: Record<string, unknown> | null | undefined, security?: Record<string, unknown> | null): {
    ok: boolean;
    mode: string;
    reason: string;
    details: Record<string, unknown>;
    nodePath: string | null;
    storeGuardScript?: undefined;
} | {
    ok: boolean;
    mode: string;
    reason: null;
    details: Record<string, unknown>;
    nodePath: string;
    storeGuardScript: string;
} | {
    ok: boolean;
    mode: string;
    reason: string;
    details: {
        protectedModeOn: true;
        hasIpcServer: boolean;
        ipcServerListening: boolean;
        hasAbsolutePluginDir: boolean;
        hasNodeBinary: boolean;
    };
    nodePath: string | null;
    storeGuardScript?: undefined;
} | {
    ok: boolean;
    mode: string;
    reason: null;
    details: {
        protectedModeOn: true;
        hasIpcServer: boolean;
        ipcServerListening: boolean;
        hasAbsolutePluginDir: boolean;
        hasNodeBinary: boolean;
    };
    nodePath: string;
    storeGuardScript?: undefined;
};
/**
 * Verify every hook script the adapter will reference actually exists
 * on disk. Returns a list of missing files; empty list = all good.
 *
 * Catches the cloud-sync conflict-rename case (iCloud/OneDrive/Dropbox/
 * Syncthing renaming the `hooks/` folder to `hooks 2/` on conflict) at
 * pre-flight rather than at first hook fire.
 */
declare function _verifyHookScripts(pluginDir: string): string[];
/**
 * Prepare hook installation for a single provider spawn.
 *
 * @param {object} params
 * @param {string} params.kind     — provider kind: "claude-code" | "codex-cli" | "gemini-cli"
 * @param {object} params.plugin   — Gryphon plugin instance (must expose ipcServer + absolutePluginDir())
 * @param {object} [params.options]— per-spawn options (currently unused; reserved for future
 *                                    provider-specific tweaks like permissionMode-driven matchers)
 *
 * @returns {{
 *   ok: boolean,                — true iff the adapter wired hooks successfully
 *   env: object,                — env vars to merge into spawn
 *   args: string[],             — CLI args to push onto spawn argv
 *   cleanup: () => void,        — call when the spawned process exits
 *   degradationReason: string|null, — populated when ok=false
 *   details: object,            — pre-flight component breakdown for debug logging
 *   missing: string[],          — list of missing hook script files (empty when ok)
 * }}
 */
declare function prepareSpawn({ kind, plugin, options }: {
    kind: string;
    plugin: Record<string, unknown> | null | undefined;
    options?: Record<string, unknown>;
}): {
    degradationReason: string;
    details: unknown;
    mode: string;
    ok: boolean;
    env: {};
    args: never[];
    cleanup: () => void;
    missing: never[];
} | {
    ok: boolean;
    mode: string;
    env: Record<string, string>;
    args: string[];
    cleanup: () => void;
    degradationReason: string;
    details: unknown;
    missing: never[];
    settingsFile: string | null | undefined;
} | {
    degradationReason: string;
    ok: boolean;
    env: {};
    args: never[];
    cleanup: () => void;
    details: {};
    missing: never[];
    mode?: undefined;
    settingsFile?: undefined;
} | {
    degradationReason: string;
    details: {
        protectedModeOn: boolean;
    };
    mode: null;
    ok: boolean;
    env: {};
    args: never[];
    cleanup: () => void;
    missing: never[];
    settingsFile?: undefined;
} | {
    degradationReason: string | null;
    details: Record<string, unknown> | {
        protectedModeOn: true;
        hasIpcServer: boolean;
        ipcServerListening: boolean;
        hasAbsolutePluginDir: boolean;
        hasNodeBinary: boolean;
    };
    mode: string;
    ok: boolean;
    env: {};
    args: never[];
    cleanup: () => void;
    missing: never[];
    settingsFile?: undefined;
} | {
    ok: boolean;
    mode: string;
    env: Record<string, string>;
    args: string[];
    cleanup: () => void;
    degradationReason: null;
    details: Record<string, unknown> | {
        protectedModeOn: true;
        hasIpcServer: boolean;
        ipcServerListening: boolean;
        hasAbsolutePluginDir: boolean;
        hasNodeBinary: boolean;
    };
    missing: never[];
    settingsFile: string | null | undefined;
};
/**
 * Convenience: build a permissions-only fallback (deny-list only, no
 * hooks) for the claude-code path when full hook installation fails
 * pre-flight. Other providers don't have an equivalent fallback today;
 * the dispatcher just returns null for them.
 */
declare function preparePermissionsFallback({ kind, plugin, denyGlobs }: {
    kind: string;
    plugin: Record<string, unknown>;
    denyGlobs: string[];
}): {
    ok: boolean;
    env: Record<string, string>;
    args: string[];
    cleanup: () => void;
    settingsFile: string | null | undefined;
    error?: undefined;
} | {
    ok: boolean;
    error: unknown;
    env?: undefined;
    args?: undefined;
    cleanup?: undefined;
    settingsFile?: undefined;
} | null;
export { prepareSpawn, preparePermissionsFallback, _preflight, // exported for tests
_verifyHookScripts, };
