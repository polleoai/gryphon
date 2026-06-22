/**
 * Hook settings file builder (v0.6.0 Stage 3).
 *
 * Generates the JSON Claude Code consumes when spawned with
 * `--settings <path>`. We pass a per-spawn temp file rather than
 * mutating the user's global `~/.claude/settings.json`, so:
 *
 *   - A crashed Gryphon never leaves hook config behind in the user's
 *     home directory that would affect their next non-Gryphon `claude`
 *     invocation.
 *   - Two vaults running Gryphon simultaneously don't stomp on each
 *     other's settings.
 *   - The Obsidian plugin owns the lifecycle: load creates, unload
 *     deletes, no persistent side effects.
 *
 * Output shape mirrors CC's documented hooks schema:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse":  [ { "matcher": "...", "hooks": [{ type, command, timeout }] } ],
 *       "PostToolUse": [...],
 *       "SessionStart": [...],
 *       ...
 *     }
 *   }
 *
 * We use absolute paths for both the node binary and the hook script
 * so the command works regardless of CC's cwd. Paths are JSON-quoted
 * inside the command string so spaces/special chars in user home
 * paths don't break shell parsing.
 *
 * Windows specifics: each hook entry carries `"shell": "powershell"`
 * so CC invokes the command via PowerShell instead of its default
 * Git Bash. See `makeCommand` for the full rationale — TL;DR is that
 * Git Bash's POSIX-to-Win32 argv translation for native binaries like
 * node.exe is unreliable, and PowerShell with native Windows paths
 * sidesteps the whole handoff.
 */
declare const DEFAULT_HOOK_TIMEOUTS: {
    PreToolUse: number;
    PostToolUse: number;
    SessionStart: number;
    SessionEnd: number;
    UserPromptSubmit: number;
    Notification: number;
};
declare const HOOK_FILES: Record<string, string>;
declare const POSTTOOL_MATCHER = "WebFetch|WebSearch|Bash|Read|Glob|Grep|Write";
/**
 * Build the settings JSON object. The caller is responsible for
 * writing it to disk (use `writeHookSettingsFile`) and passing the
 * path to CC via `--settings`.
 *
 * @param {object} params
 * @param {string} params.pluginDir  — absolute path to the Gryphon plugin dir
 * @param {string} params.socketPath — absolute path to the IPC socket (for hooks' env var)
 * @param {string} [params.nodePath] — node binary; defaults to the current process's node
 * @param {object} [params.timeouts] — per-hook timeout overrides (seconds)
 */
declare function buildHookSettings(params: any): {
    hooks: {
        PreToolUse: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
        PostToolUse: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
        SessionStart: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
        SessionEnd: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
        UserPromptSubmit: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
        Notification: {
            matcher: any;
            hooks: Record<string, any>[];
        }[];
    };
};
/**
 * Build a settings object containing ONLY a `permissions.deny` array,
 * no hooks block. Used on the fallback path — when `hookInstrumentation`
 * is off or when hook pre-flight fails, Gryphon still wants to push its
 * protected-pattern list to CC as native deny rules so basic enforcement
 * survives even without the approve-modal UX.
 *
 * Why a dedicated function vs. parameterising `buildHookSettings`:
 *
 *   - The hooks-path settings file MUST NOT include permissions.deny;
 *     CC applies deny rules *before* dispatching PreToolUse hooks, so
 *     mixing the two would short-circuit our approval modal for every
 *     matching pattern.
 *
 *   - The fallback settings file MUST NOT include hooks; registering
 *     hook commands while the IPC server isn't listening would leave
 *     CC timing-out on every hook call (300s per tool call at worst).
 *
 * Historical context: we used to emit one `--disallowedTools <glob>`
 * per rule on argv. With ~180 rules on Windows that pushed past
 * cmd.exe's 8191-char hard limit ("The command line is too long" from
 * the shim). Moving the list into the settings JSON drops argv length
 * to near-zero regardless of rule count.
 */
declare function buildPermissionsOnlySettings(denyRules: any): {
    permissions: {
        deny: any[];
    };
};
/**
 * Write the settings object to a uniquely-named file in the OS temp
 * directory and return its absolute path. Caller is responsible for
 * deleting the file when CC exits.
 *
 * Atomic write (temp + rename) isn't necessary here — we're the only
 * writer and a partial file just means CC fails to parse and the
 * spawn aborts, which is visible and recoverable.
 */
declare function writeHookSettingsFile(settings: any): string;
export { buildHookSettings, buildPermissionsOnlySettings, writeHookSettingsFile, DEFAULT_HOOK_TIMEOUTS, HOOK_FILES, POSTTOOL_MATCHER, };
