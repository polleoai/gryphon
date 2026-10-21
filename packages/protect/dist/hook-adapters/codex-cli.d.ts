declare const KIND = "codex-cli";
type StoreGuardOnly = {
    scriptPath: string;
    approvalsDir: string;
};
declare const PRESERVED_FROM_REAL_HOME: string[];
declare function _tomlString(s: string): string;
/**
 * R3-1: Codex applies the PROJECT config layer — a `.codex/config.toml` in
 * the vault or any folder above it up to the repo root — even under
 * `codex exec` with an overlay CODEX_HOME, and that layer can start
 * `mcp_servers` at session start (no tool call, so no hook) or widen the
 * sandbox (`sandbox_workspace_write.writable_roots`). Verified live, codex
 * 0.145: a vault's MCP server ran on a plain "say hi". Marking the vault and
 * every folder above it untrusted in OUR user layer stops Codex from
 * applying those layers (a `-c projects…` override did not). These entries
 * live only in Gryphon's per-spawn overlay; the user's own ~/.codex is
 * untouched.
 */
declare function _projectTrustToml(projectDir: string | null | undefined): string;
/** Codex's trust hash for one command hook (null for an event Codex doesn't know). */
declare function _codexHookTrustHash(eventName: string, matcher: string, command: string, timeout: number): string | null;
/**
 * The `[hooks.state]` tables that trust each rendered hook. Each event
 * has exactly one matcher group with one handler, so its key is
 * `<configPath>:<label>:0:0`. `configPath` must be the exact path Codex
 * will read (the overlay is built under a realpath for this reason).
 */
declare function _renderTrustState(configPath: string, hooks: Array<[string, string, string, number]>): string;
/**
 * Convert GRYPHON_SYSTEM_PROMPT_HINT (newline-free, "·"-bulleted)
 * into a markdown document suitable for Codex's
 * `model_instructions_file` config. Codex prepends/uses this file
 * as additional model instructions at session creation time.
 *
 * The hint already enforces no-embedded-newlines for shell-arg
 * compatibility on Windows; for the file path we don't need that
 * constraint, so we expand the bullets into proper markdown for
 * better model adherence (LLMs follow visually-formatted bullets
 * more reliably than inline "·" separators).
 */
declare function _buildModelInstructions(): string;
/**
 * Build the canonical hook-config TOML string. Mirrors the JSON shape
 * `buildHookSettings` returns for claude-code, just rendered in TOML.
 *
 * Also references the model_instructions_file (written by
 * _createCodexHomeOverlay) so Codex's model receives Gryphon's
 * anti-leak + compound-request directives on every session.
 */
declare function _buildHooksToml({ pluginDir, nodePath, modelInstructionsFile, configPath }: {
    pluginDir: string;
    nodePath: string;
    modelInstructionsFile: string;
    configPath?: string;
}): string;
/**
 * Issue #30: store-guard-only config — a single PreToolUse hook, nothing
 * else (no other events, no model instructions). Protected Mode is off, so
 * the only thing Gryphon adds is the trust-store check.
 */
declare function _buildStoreGuardToml({ nodePath, storeGuard, configPath }: {
    nodePath: string;
    storeGuard: StoreGuardOnly;
    configPath?: string;
}): string;
/**
 * Create a CODEX_HOME overlay directory: a fresh tmpdir containing our
 * config.toml plus symlinks to the user's real auth/session/plugin
 * artifacts. Returns the absolute path to the overlay.
 *
 * The overlay is per-spawn — each `codex exec` invocation gets its
 * own tmpdir, cleaned up on close. This isolates Gryphon's hook
 * config from the user's interactive `codex` use, and protects
 * against multi-vault cross-contamination.
 */
declare function _createCodexHomeOverlay({ pluginDir, nodePath, storeGuard, projectDir, trustOnly }: {
    pluginDir?: string;
    nodePath?: string;
    storeGuard?: StoreGuardOnly;
    projectDir?: string | null;
    trustOnly?: boolean;
}): string;
/**
 * Recursive cleanup: remove the overlay directory tree (symlinks +
 * config.toml). Best-effort — a leftover overlay in tmpdir is harmless
 * (nothing else looks for it), but we log on failure for visibility.
 */
declare function _cleanupOverlay(overlay: string | null): void;
/**
 * Adapter contract — see hook-dispatcher.js for the schema.
 */
declare function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, storeGuardOnly, options }: {
    pluginDir?: string;
    ipcSocketPath?: string;
    nodePath: string;
    storeGuardOnly?: StoreGuardOnly;
    options?: Record<string, unknown>;
}): {
    env: {
        CODEX_HOME: string;
        GRYPHON_HOOK_PROVIDER: string;
        GRYPHON_PERMISSION_SOCKET?: undefined;
    };
    args: string[];
    cleanup: () => void;
    settingsFile: string;
} | {
    env: {
        CODEX_HOME: string;
        GRYPHON_PERMISSION_SOCKET: string;
        GRYPHON_HOOK_PROVIDER: string;
    };
    args: string[];
    cleanup: () => void;
    settingsFile: string;
} | null;
/**
 * R3-1: a CODEX_HOME that carries only the project-trust entries — for a
 * spawn whose hooks couldn't be installed, so the vault's own Codex config
 * still doesn't apply. Throws when the folder can't be encoded safely.
 */
declare function buildTrustOnlyOverlay({ projectDir }: {
    projectDir: string;
}): {
    env: {
        CODEX_HOME: string;
    };
    cleanup: () => void;
};
export { KIND as kind, buildSpawnExtras, buildTrustOnlyOverlay, _projectTrustToml, _tomlString, _buildHooksToml, _codexHookTrustHash, _renderTrustState, _buildStoreGuardToml, _buildModelInstructions, _createCodexHomeOverlay, _cleanupOverlay, PRESERVED_FROM_REAL_HOME, };
