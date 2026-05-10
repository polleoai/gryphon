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

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_HOOK_TIMEOUTS = {
  PreToolUse: 300,       // user may read the modal for a while before deciding
  PostToolUse: 10,       // automated, regex scan + IPC round-trip
  SessionStart: 10,      // IPC ping + fail-closed check
  SessionEnd: 5,         // cleanup ping
  UserPromptSubmit: 10,  // regex scan
  Notification: 2,       // fire-and-forget notice forwarding
};

const HOOK_FILES = {
  PreToolUse: "pretool.js",
  PostToolUse: "posttool.js",
  SessionStart: "session-start.js",
  SessionEnd: "session-end.js",
  UserPromptSubmit: "user-prompt.js",
  Notification: "notification.js",
};

// PostToolUse fires for (a) tools whose output might contain
// attacker-authored text (so we can frame it) and (b) tools that
// produce vault files we need to tag in the provenance store.
// Write is in (b): its tool_response is just a confirmation string
// (no framing — posttool.js skips the framing branch for Write), but
// the hook MUST fire so provenance_add can run when the session is
// currently untrustedContentActive. Edit is intentionally omitted —
// edits are user-intended modifications of existing files, not fresh
// content arriving from an untrusted source.
const POSTTOOL_MATCHER = "WebFetch|WebSearch|Bash|Read|Glob|Grep|Write";

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
function buildHookSettings(params) {
  if (!params || typeof params !== "object") {
    throw new TypeError("buildHookSettings(params): params required");
  }
  const { pluginDir, socketPath } = params;
  if (typeof pluginDir !== "string" || pluginDir.length === 0) {
    throw new TypeError("buildHookSettings: pluginDir must be a non-empty absolute path");
  }
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new TypeError("buildHookSettings: socketPath must be a non-empty string");
  }
  const nodePath = params.nodePath || process.execPath;
  const timeouts = Object.assign({}, DEFAULT_HOOK_TIMEOUTS, params.timeouts || {});
  const hooksDir = path.join(pluginDir, "hooks");

  // Build one hook command record. Shape differs by platform:
  //
  //   POSIX   → `{ command: '"node" "/path/script.js"' }`
  //             Bash tokenizes the quoted strings; node gets a real path.
  //
  //   Windows → `{ command: "& 'C:\\...\\node.exe' 'C:\\...\\script.js'",
  //                shell: "powershell" }`
  //             We ask CC to route via PowerShell (documented `shell`
  //             field) instead of its default Git Bash. Two layered
  //             reasons for the specific shape:
  //
  //   1. Why PowerShell, not bash: when CC uses Git Bash it passes argv
  //      strings verbatim to native Win32 binaries like node.exe.
  //      MSYS2's POSIX-to-Win32 arg translation is unreliable from
  //      Git-for-Windows bash — node.exe ends up trying to
  //      CreateFile("/c/Users/.../script.js"), which Windows rejects,
  //      and the hook silently never runs.
  //
  //   2. Why single quotes around the paths, not double: CC wraps the
  //      hook command string inside its own argument to powershell.exe
  //      (roughly `powershell.exe -Command "<our-string>"`). If our
  //      string contains its own " characters, the outer wrapper
  //      consumes them and PowerShell sees a mangled command — hook
  //      silently doesn't fire. PowerShell single-quoted strings are
  //      literal (backslashes and spaces pass through untouched), so
  //      they coexist with the outer " wrapper. Windows filenames
  //      can't contain ', so we don't need to escape inside.
  //
  //   The `&` (call operator) lets us invoke a quoted path containing
  //   spaces (e.g. "C:\Program Files\nodejs\...").
  const makeCommand = (scriptName) => {
    const scriptPath = path.join(hooksDir, scriptName);
    if (process.platform === "win32") {
      return {
        command: `& '${nodePath}' '${scriptPath}'`,
        shell: "powershell",
      };
    }
    return {
      command: `${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)}`,
    };
  };

  const makeEntry = (hookEvent, matcher) => {
    const cmd = makeCommand(HOOK_FILES[hookEvent]);
    const hookRecord = {
      type: "command",
      command: cmd.command,
      timeout: timeouts[hookEvent],
    };
    // Only emit `shell` when non-default. CC's docs list "bash" as the
    // default; including it redundantly would just bloat the settings
    // file and risks trouble if a future CC rejects unknown values.
    if (cmd.shell) hookRecord.shell = cmd.shell;
    return { matcher, hooks: [hookRecord] };
  };

  return {
    hooks: {
      PreToolUse: [makeEntry("PreToolUse", "")],
      PostToolUse: [makeEntry("PostToolUse", POSTTOOL_MATCHER)],
      SessionStart: [makeEntry("SessionStart", "")],
      SessionEnd: [makeEntry("SessionEnd", "")],
      UserPromptSubmit: [makeEntry("UserPromptSubmit", "")],
      Notification: [makeEntry("Notification", "")],
    },
  };
}

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
function buildPermissionsOnlySettings(denyRules) {
  const rules = Array.isArray(denyRules)
    ? denyRules.filter((r) => typeof r === "string" && r.length > 0)
    : [];
  return { permissions: { deny: rules } };
}

/**
 * Write the settings object to a uniquely-named file in the OS temp
 * directory and return its absolute path. Caller is responsible for
 * deleting the file when CC exits.
 *
 * Atomic write (temp + rename) isn't necessary here — we're the only
 * writer and a partial file just means CC fails to parse and the
 * spawn aborts, which is visible and recoverable.
 */
function writeHookSettingsFile(settings) {
  // pid + timestamp + random 4-byte hex. The hex suffix disambiguates
  // calls that land in the same millisecond (common in tests and
  // plausible on first-spawn during a chat open). 4 bytes (32 bits)
  // of entropy is enough to make collisions vanishingly improbable
  // within the millisecond window; `wx` adds O_EXCL on top so even
  // if the name happened to exist we'd error rather than overwrite.
  const rand = crypto.randomBytes(4).toString("hex");
  const name = `gryphon-cc-settings-${process.pid}-${Date.now()}-${rand}.json`;
  const fullPath = path.join(os.tmpdir(), name);
  // `wx` = O_CREAT|O_EXCL — refuses to write through an existing file
  // or symlink. Prevents symlink-race attacks on shared multi-user
  // POSIX systems where another local user could `ln -s
  // ~/.ssh/authorized_keys /tmp/gryphon-cc-settings-<guessed>.json`
  // between our path generation and our write, leading us to
  // overwrite sensitive targets. On a single-user machine this
  // flag is a no-op; on shared hosts it's the only defense.
  //
  // `mode: 0o600` restricts read/write to the owning user only. The
  // settings JSON contains absolute plugin paths and, in fallback
  // mode, the user's protected-pattern list — neither is a secret
  // but neither needs to be world-readable in /tmp.
  fs.writeFileSync(fullPath, JSON.stringify(settings, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return fullPath;
}

module.exports = {
  buildHookSettings,
  buildPermissionsOnlySettings,
  writeHookSettingsFile,
  DEFAULT_HOOK_TIMEOUTS,
  HOOK_FILES,
  POSTTOOL_MATCHER,
};
