declare const KIND = "claude-code";
/**
 * Translate a canonical-ish hook-config request into Claude Code spawn
 * extras.
 *
 * @param {object} args
 * @param {string} args.pluginDir       — absolute path to the Gryphon plugin
 * @param {string} args.ipcSocketPath   — absolute path to the IPC socket
 * @param {string} args.nodePath        — absolute path to a real node binary
 * @param {object} [args.permissionsOnly] — fallback config (deny-list only)
 *                                           passed when hook installation
 *                                           failed pre-flight; adapter writes
 *                                           a permissions-only settings file
 *                                           so basic enforcement survives.
 * @returns {{ env, args, cleanup, settingsFile }}
 */
declare function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, permissionsOnly }: {
    pluginDir: string;
    ipcSocketPath: string;
    nodePath: string;
    permissionsOnly?: {
        denyGlobs: string[];
    } | null;
}): {
    env: Record<string, string>;
    args: string[];
    cleanup: () => void;
    settingsFile: string;
};
export { KIND as kind, buildSpawnExtras };
