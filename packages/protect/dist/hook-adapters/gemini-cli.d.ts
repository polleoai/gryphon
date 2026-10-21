declare const KIND = "gemini-cli";
type StoreGuardOnly = {
    scriptPath: string;
    approvalsDir: string;
};
/**
 * Issue #30: store-guard-only settings — a single BeforeTool hook. Gemini's
 * `timeout` is MILLISECONDS (see _buildHooksJson).
 */
declare function _buildStoreGuardJson({ nodePath, storeGuard, nonce }: {
    nodePath: string;
    storeGuard: StoreGuardOnly;
    nonce?: string;
}): {
    hooksConfig: {
        enabled: boolean;
    };
    hooks: {
        BeforeTool: {
            matcher: string;
            hooks: Record<string, unknown>[];
        }[];
    };
};
/**
 * Mapping from Gryphon's canonical hook events (Claude-Code-named)
 * to Gemini's event names + the matcher to use. Order matches the
 * claude-code/codex builders so behavior parity is easy to audit.
 */
declare const GEMINI_HOOK_EVENTS: Array<[string, string, string, string]>;
/**
 * Build the canonical hook-config JSON object Gemini reads from
 * settings.json. Mirrors the JSON shape `buildHookSettings` returns
 * for claude-code, just with different event names per the table
 * above and Gemini's per-hook `name` field (used in error logs).
 */
declare function _buildHooksJson({ pluginDir, nodePath, nonce }: {
    pluginDir: string;
    nodePath: string;
    nonce?: string;
}): {
    hooksConfig: {
        enabled: boolean;
    };
    hooks: Record<string, unknown[]>;
};
/**
 * Render the model-instructions content. Same source as Codex's
 * adapter — the directives are provider-agnostic.
 */
declare function _buildModelInstructions(): string;
declare function _writeSettingsFile(settings: Record<string, unknown>): string;
declare function _cleanupFile(file: string | null | undefined): void;
/**
 * Adapter contract — see hook-dispatcher.js for the schema.
 *
 * Returns env vars + cleanup. No CLI args are added (Gemini reads
 * the settings file from the env-var-pointed path automatically).
 *
 * Env vars set:
 *   - GEMINI_CLI_SYSTEM_SETTINGS_PATH — points at our hooks
 *     settings.json
 *   - GRYPHON_PERMISSION_SOCKET — IPC socket path the hook scripts
 *     dial back to
 *   - GRYPHON_HOOK_DIALECT=gemini — tells the shared hook scripts
 *     to emit Gemini's `{decision, reason}` output shape instead of
 *     Claude Code's `{hookSpecificOutput: {permissionDecision, ...}}`
 */
declare function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, storeGuardOnly }: {
    pluginDir?: string;
    ipcSocketPath?: string;
    nodePath: string;
    storeGuardOnly?: StoreGuardOnly;
}): {
    env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: string;
        GRYPHON_HOOK_PROVIDER: string;
        GRYPHON_PERMISSION_SOCKET?: undefined;
        GRYPHON_HOOK_DIALECT?: undefined;
        GEMINI_SYSTEM_MD?: undefined;
    };
    args: never[];
    cleanup: () => void;
    settingsFile: string;
    instructionsFile?: undefined;
} | {
    env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: string;
        GRYPHON_PERMISSION_SOCKET: string;
        GRYPHON_HOOK_DIALECT: string;
        GRYPHON_HOOK_PROVIDER: string;
        GEMINI_SYSTEM_MD: string;
    };
    args: never[];
    cleanup: () => void;
    settingsFile: string;
    instructionsFile: string;
} | null;
export { KIND as kind, buildSpawnExtras, _buildHooksJson, _buildStoreGuardJson, _buildModelInstructions, _writeSettingsFile, _cleanupFile, GEMINI_HOOK_EVENTS, };
