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
export {};
