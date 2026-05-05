/**
 * Codex CLI hook adapter.
 *
 * Codex CLI v0.117.0+ implements Claude Code's hook protocol verbatim
 * — same JSON wire format, same env vars (CLAUDE_PLUGIN_ROOT etc.).
 * The only differences from the claude-code adapter:
 *
 *   1. Config file format: TOML (in `<CODEX_HOME>/config.toml`) vs.
 *      JSON (passed via `--settings`).
 *   2. Spawn-time wiring: env var (`CODEX_HOME`) vs. CLI flag.
 *   3. Auth preservation: Codex's `auth.json` lives in the user's real
 *      `~/.codex/`. Pointing `CODEX_HOME` at our tmpdir would break
 *      login, so we symlink `auth.json` (and a few related files)
 *      from the real home into our overlay.
 *
 * The hook scripts themselves (`hooks/pretool.js`, `hooks/posttool.js`,
 * etc.) are reused unchanged — Codex consumes them with the same
 * stdin/stdout JSON contract Claude Code uses.
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

const KIND = "codex-cli";

// Files we symlink from the real ~/.codex/ into our overlay so Codex
// retains login state and can resume prior sessions. Kept minimal:
//
//   auth.json     — required for ChatGPT/API auth (Codex 401s without it)
//   sessions/     — required for `codex exec resume <thread_id>` to find
//                   the prior session JSONL
//   models_cache.json — performance optimization (Codex re-fetches
//                   without it but the model list URL request is slow);
//                   safe to symlink because it's read-only metadata
//
// We deliberately do NOT preserve plugins/, skills/, marketplaces/,
// or sqlite state files. Those carry user-side mutable state that
// could conflict between Gryphon's overlay and the user's interactive
// `codex` use, AND surprisingly Codex enters a degraded mode when it
// sees inconsistent state.sqlite (turn.completed with no agent_message).
//
// Empirically determined: with the larger symlink list, Codex spawns
// and authenticates but produces no model output. With this minimal
// list it works correctly. Re-add entries one at a time only if a
// real user-reported feature regresses.
const PRESERVED_FROM_REAL_HOME = [
  "auth.json",
  "sessions",
  "models_cache.json",
];

/**
 * Render one [[hooks.<EventName>]] block in TOML form.
 *
 * Codex's TOML config schema mirrors Claude Code's JSON exactly:
 *   [[hooks.PreToolUse]]
 *   matcher = "regex"
 *
 *   [[hooks.PreToolUse.hooks]]
 *   type = "command"
 *   command = "..."
 *   timeout = 300
 */
function _renderHookBlock(eventName, matcher, command, timeout) {
  return [
    `[[hooks.${eventName}]]`,
    `matcher = ${JSON.stringify(matcher)}`,
    ``,
    `[[hooks.${eventName}.hooks]]`,
    `type = "command"`,
    `command = ${JSON.stringify(command)}`,
    `timeout = ${timeout}`,
    ``,
  ].join("\n");
}

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

/**
 * Build the canonical hook-config TOML string. Mirrors the JSON shape
 * `buildHookSettings` returns for claude-code, just rendered in TOML.
 *
 * Also references the model_instructions_file (written by
 * _createCodexHomeOverlay) so Codex's model receives Gryphon's
 * anti-leak + compound-request directives on every session.
 */
function _buildHooksToml({ pluginDir, nodePath, modelInstructionsFile }) {
  const hooksDir = path.join(pluginDir, "hooks");
  const isWindows = process.platform === "win32";

  // Per-platform command quoting: same logic as the claude-code hook
  // builder. POSIX uses JSON-quoted bash tokens; Windows uses
  // single-quoted PowerShell paths inside an `&` invocation.
  const makeCommand = (scriptName) => {
    const scriptPath = path.join(hooksDir, scriptName);
    if (isWindows) {
      return `& '${nodePath}' '${scriptPath}'`;
    }
    return `${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)}`;
  };

  const events = [
    ["PreToolUse",        "",                 HOOK_FILES.PreToolUse],
    ["PostToolUse",       POSTTOOL_MATCHER,   HOOK_FILES.PostToolUse],
    ["SessionStart",      "",                 HOOK_FILES.SessionStart],
    ["SessionEnd",        "",                 HOOK_FILES.SessionEnd],
    ["UserPromptSubmit",  "",                 HOOK_FILES.UserPromptSubmit],
    ["Notification",      "",                 HOOK_FILES.Notification],
  ];

  // Header: Codex distinguishes [hooks] (single table) from
  // [[hooks.<event>]] (array of tables). Each event can have multiple
  // matcher/command groups.
  let toml = "# Gryphon-managed Codex hook config (regenerated per spawn).\n\n";
  // Point Codex at our model-instructions file. The directives in that
  // file are essential for clean refusal UX (no "PreToolUse hook"
  // wording leaks) and the compound-request rule (complete safe sub-
  // tasks even when one is refused).
  if (modelInstructionsFile) {
    toml += `model_instructions_file = ${JSON.stringify(modelInstructionsFile)}\n\n`;
  }
  for (const [event, matcher, scriptName] of events) {
    const cmd = makeCommand(scriptName);
    toml += _renderHookBlock(event, matcher, cmd, DEFAULT_HOOK_TIMEOUTS[event]);
    toml += "\n";
  }
  return toml;
}

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
function _createCodexHomeOverlay({ pluginDir, nodePath }) {
  const realHome = path.join(os.homedir(), ".codex");
  const rand = crypto.randomBytes(4).toString("hex");
  const overlay = path.join(
    os.tmpdir(),
    `gryphon-codex-home-${process.pid}-${Date.now()}-${rand}`,
  );

  fs.mkdirSync(overlay, { recursive: true, mode: 0o700 });

  // Symlink each preserved entry from the real home if it exists.
  // Symlinks (vs. copies) keep auth-token rotation, session history,
  // and plugin updates in sync with the user's real Codex state with
  // zero additional bookkeeping.
  for (const name of PRESERVED_FROM_REAL_HOME) {
    const real = path.join(realHome, name);
    const linkPath = path.join(overlay, name);
    if (!fs.existsSync(real)) continue;
    try {
      fs.symlinkSync(real, linkPath);
    } catch (e) {
      // EEXIST shouldn't happen (fresh tmpdir), EPERM on Windows when
      // not running as admin — fall through to copyFile for the
      // small/critical files (auth.json), warn for the rest.
      if (e.code === "EPERM" && (name === "auth.json" || name === "session_index.jsonl")) {
        try { fs.copyFileSync(real, linkPath); }
        catch (e2) { console.warn(`[gryphon/codex-hooks] couldn't preserve ${name}: ${e2.message}`); }
      } else if (e.code !== "EEXIST") {
        console.warn(`[gryphon/codex-hooks] symlink ${name} failed: ${e.message}`);
      }
    }
  }

  // Write the model-instructions file FIRST so config.toml can
  // reference it by absolute path. Codex loads this file at session
  // creation and surfaces its content as additional model instructions
  // — it's how we get the "no hook leak / complete safe sub-requests"
  // directives in front of the Codex model.
  //
  // QA-V13H-A: if either write throws (disk full, EPERM, antivirus
  // mid-scan), tear down the partially-built overlay so the tmpdir
  // doesn't leak. `buildSpawnExtras` returns null/throws on failure
  // and the caller never gets the cleanup callback — without this
  // rollback every failed spawn leaves a 4-KB stub in tmpdir.
  try {
    const modelInstructionsFile = path.join(overlay, "model-instructions.md");
    fs.writeFileSync(modelInstructionsFile, _buildModelInstructions(), {
      flag: "wx",
      mode: 0o600,
    });

    // Write our config.toml — this is the file Codex reads to discover
    // the hook commands and the model_instructions_file pointer. The
    // user's real config.toml is intentionally NOT preserved; Gryphon
    // owns the hook + model-instructions section and the rest defaults
    // are fine for our use.
    const configPath = path.join(overlay, "config.toml");
    fs.writeFileSync(
      configPath,
      _buildHooksToml({ pluginDir, nodePath, modelInstructionsFile }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (e) {
    _cleanupOverlay(overlay);
    throw e;
  }

  return overlay;
}

/**
 * Recursive cleanup: remove the overlay directory tree (symlinks +
 * config.toml). Best-effort — a leftover overlay in tmpdir is harmless
 * (nothing else looks for it), but we log on failure for visibility.
 */
function _cleanupOverlay(overlay) {
  if (!overlay) return;
  try {
    if (fs.existsSync(overlay)) {
      // rmSync with force=true removes symlinks too without following
      // them. recursive=true so the directory itself is removed.
      fs.rmSync(overlay, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`[gryphon/codex-hooks] failed to remove overlay ${overlay}: ${e.message}`);
  }
}

/**
 * Adapter contract — see hook-dispatcher.js for the schema.
 */
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath }) {
  if (!pluginDir || !ipcSocketPath || !nodePath) {
    // Dispatcher pre-flight should have caught these; defensive only.
    return null;
  }
  const overlay = _createCodexHomeOverlay({ pluginDir, nodePath });
  return {
    env: {
      CODEX_HOME: overlay,
      GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
    },
    args: [], // Codex picks up hooks from <CODEX_HOME>/config.toml — no CLI flag needed.
    cleanup: () => _cleanupOverlay(overlay),
    settingsFile: path.join(overlay, "config.toml"),
  };
}

module.exports = {
  kind: KIND,
  buildSpawnExtras,
  // Internals exposed for tests:
  _buildHooksToml,
  _buildModelInstructions,
  _createCodexHomeOverlay,
  _cleanupOverlay,
  PRESERVED_FROM_REAL_HOME,
};
