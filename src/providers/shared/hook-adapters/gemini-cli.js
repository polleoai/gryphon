/**
 * Gemini CLI hook adapter.
 *
 * Gemini CLI's hook system uses the same JSON-over-stdin contract
 * Claude Code pioneered, but with two surface differences:
 *
 *   1. Event names are Gemini-flavored:
 *        Claude/Codex            Gemini
 *        ─────────────           ──────
 *        PreToolUse              BeforeTool
 *        PostToolUse             AfterTool
 *        UserPromptSubmit        BeforeAgent  (closest analog)
 *        SessionStart            SessionStart   (same)
 *        SessionEnd              SessionEnd     (same)
 *        Notification            Notification   (same)
 *
 *   2. Output schema is flat with different field names:
 *        Claude/Codex: { hookSpecificOutput: { hookEventName,
 *                          permissionDecision, permissionDecisionReason } }
 *        Gemini:       { decision, reason, systemMessage }
 *
 *      We handle (2) by passing GRYPHON_HOOK_DIALECT=gemini in the
 *      spawn env — the shared hook scripts (hooks/pretool.js etc.)
 *      check that var and emit the right shape. Input field names
 *      are the SAME across all three CLIs (`tool_name`, `tool_input`,
 *      `session_id`, `hook_event_name`), so no input adapter is
 *      needed.
 *
 * Spawn-time wiring: write a tmp settings.json containing the hook
 * registrations and point Gemini at it via
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>`. This keeps Gryphon's
 * hook config out of the user's real ~/.gemini/settings.json so:
 *
 *   - A crashed Gryphon never leaves config behind that affects the
 *     user's interactive `gemini` use.
 *   - Two vaults running Gryphon don't stomp on each other.
 *   - The plugin owns the lifecycle: spawn creates, close deletes.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const {
  DEFAULT_HOOK_TIMEOUTS,
  HOOK_FILES,
  POSTTOOL_MATCHER,
} = require("../../claude-code/hook-settings-builder");
const {
  GRYPHON_SYSTEM_PROMPT_HINT,
  GRYPHON_FALLBACK_DENY_HINT,
} = require("../system-prompt-hints");

const KIND = "gemini-cli";

/**
 * Mapping from Gryphon's canonical hook events (Claude-Code-named)
 * to Gemini's event names + the matcher to use. Order matches the
 * claude-code/codex builders so behavior parity is easy to audit.
 */
const GEMINI_HOOK_EVENTS = [
  // [geminiEventName, hookFileName, matcher, timeoutKey]
  ["BeforeTool",       HOOK_FILES.PreToolUse,       "",                "PreToolUse"],
  ["AfterTool",        HOOK_FILES.PostToolUse,      POSTTOOL_MATCHER,  "PostToolUse"],
  ["SessionStart",     HOOK_FILES.SessionStart,     "",                "SessionStart"],
  ["SessionEnd",       HOOK_FILES.SessionEnd,       "",                "SessionEnd"],
  // BeforeAgent is the closest Gemini analog to UserPromptSubmit —
  // fires before the agent processes a user message. The hook script
  // is the same `user-prompt.js` we ship for Claude Code.
  ["BeforeAgent",      HOOK_FILES.UserPromptSubmit, "",                "UserPromptSubmit"],
  ["Notification",     HOOK_FILES.Notification,     "",                "Notification"],
];

/**
 * Build the canonical hook-config JSON object Gemini reads from
 * settings.json. Mirrors the JSON shape `buildHookSettings` returns
 * for claude-code, just with different event names per the table
 * above and Gemini's per-hook `name` field (used in error logs).
 */
function _buildHooksJson({ pluginDir, nodePath }) {
  const hooksDir = path.join(pluginDir, "hooks");
  const isWindows = process.platform === "win32";

  const makeCommand = (scriptName) => {
    const scriptPath = path.join(hooksDir, scriptName);
    if (isWindows) {
      return {
        command: `& '${nodePath}' '${scriptPath}'`,
        shell: "powershell",
      };
    }
    return {
      command: `${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)}`,
    };
  };

  const hooksBlock = {};
  for (const [geminiEvent, scriptName, matcher, timeoutKey] of GEMINI_HOOK_EVENTS) {
    const cmd = makeCommand(scriptName);
    const hookEntry = {
      name: `gryphon-${geminiEvent.toLowerCase()}`,
      type: "command",
      command: cmd.command,
      // CRITICAL: Gemini interprets `timeout` in MILLISECONDS, while
      // Claude Code and Codex CLI both treat it as SECONDS. Our
      // DEFAULT_HOOK_TIMEOUTS table is in seconds (`PreToolUse: 300`
      // = 5 minutes), so multiply by 1000 here. Without this, the
      // hook timed out in 300 ms — far less than the user's
      // think-time on the approve/deny modal — and Gemini fell
      // through to default-allow. The rm ran, the model saw a
      // generic failure, and surfaced "file does not exist" to the
      // user. Reported by user 2026-05-03.
      timeout: DEFAULT_HOOK_TIMEOUTS[timeoutKey] * 1000,
    };
    if (cmd.shell) hookEntry.shell = cmd.shell;
    hooksBlock[geminiEvent] = [{
      // Gemini's matcher syntax: empty string means "match all" (same
      // as Claude Code). Specific patterns are tool-name regex.
      matcher: matcher || "*",
      hooks: [hookEntry],
    }];
  }

  return { hooks: hooksBlock };
}

/**
 * Render the model-instructions content. Same source as Codex's
 * adapter — the directives are provider-agnostic.
 */
function _buildModelInstructions() {
  const bullets = GRYPHON_SYSTEM_PROMPT_HINT.split("· ").map((s) => s.trim()).filter(Boolean);
  const head = bullets[0];
  const rest = bullets.slice(1).map((b) => `- ${b}`).join("\n\n");
  return [
    "# Gryphon — environment-specific instructions",
    "",
    head,
    "",
    rest,
    "",
    "## On terse environment refusals (fallback path)",
    "",
    GRYPHON_FALLBACK_DENY_HINT.replace(/^· /, ""),
    "",
  ].join("\n");
}

function _writeSettingsFile(settings) {
  const rand = crypto.randomBytes(4).toString("hex");
  const name = `gryphon-gemini-settings-${process.pid}-${Date.now()}-${rand}.json`;
  const fullPath = path.join(os.tmpdir(), name);
  fs.writeFileSync(fullPath, JSON.stringify(settings, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return fullPath;
}

function _writeModelInstructionsFile() {
  const rand = crypto.randomBytes(4).toString("hex");
  const name = `gryphon-gemini-instructions-${process.pid}-${Date.now()}-${rand}.md`;
  const fullPath = path.join(os.tmpdir(), name);
  fs.writeFileSync(fullPath, _buildModelInstructions(), {
    flag: "wx",
    mode: 0o600,
  });
  return fullPath;
}

function _cleanupFile(file) {
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    console.warn(`[gryphon/gemini-hooks] failed to remove ${file}: ${e.message}`);
  }
}

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
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath }) {
  if (!pluginDir || !ipcSocketPath || !nodePath) {
    return null;
  }
  const settings = _buildHooksJson({ pluginDir, nodePath });
  const settingsFile = _writeSettingsFile(settings);
  // QA-V13H-A: if the second write throws after the first succeeded,
  // the first file would leak in tmpdir (no cleanup function reaches
  // the caller because `buildSpawnExtras` itself rejects). Roll back
  // the first write so this adapter is idempotent under partial-
  // failure: either both files exist and `cleanup` removes them, or
  // neither file exists.
  let instructionsFile;
  try {
    instructionsFile = _writeModelInstructionsFile();
  } catch (e) {
    _cleanupFile(settingsFile);
    throw e;
  }

  const cleanup = () => {
    _cleanupFile(settingsFile);
    _cleanupFile(instructionsFile);
  };

  return {
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
      GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
      GRYPHON_HOOK_DIALECT: "gemini",
      // GEMINI_SYSTEM_MD points Gemini at a markdown file to use as
      // additional model instructions (parallel to Codex's
      // model_instructions_file). Without this, the model
      // paraphrases our deny reason instead of quoting it verbatim
      // and may improvise about the "mechanism" — leaking
      // "BeforeTool hook" / "intercept" vocabulary the user
      // shouldn't see. The directives include the COMPOUND REQUESTS
      // rule (do safe sub-tasks, then quote the deny reason) and
      // the no-leak vocabulary list. Same shared source as Claude
      // Code's --append-system-prompt and Codex's
      // model_instructions_file.
      GEMINI_SYSTEM_MD: instructionsFile,
    },
    args: [],
    cleanup,
    settingsFile,
    instructionsFile,
  };
}

module.exports = {
  kind: KIND,
  buildSpawnExtras,
  _buildHooksJson,
  _buildModelInstructions,
  _writeSettingsFile,
  _cleanupFile,
  GEMINI_HOOK_EVENTS,
};
