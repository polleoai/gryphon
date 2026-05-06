/**
 * Claude Code hook adapter.
 *
 * Wraps Gryphon's existing claude-code/hook-settings-builder.js. The
 * actual hook-config JSON shape lives there (it's what Claude Code's
 * `--settings` flag consumes). This adapter just plugs that builder
 * into the HookDispatcher's contract.
 */

const fs = require("fs");
const {
  buildHookSettings,
  buildPermissionsOnlySettings,
  writeHookSettingsFile,
} = require("../../claude-code/hook-settings-builder");

const KIND = "claude-code";

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
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, permissionsOnly }) {
  let settingsFile = null;
  let extraEnv = {};

  if (permissionsOnly) {
    // Fallback path — write a permissions.deny-only settings file. No
    // hooks block, no IPC env needed.
    const settings = buildPermissionsOnlySettings(permissionsOnly.denyGlobs);
    settingsFile = writeHookSettingsFile(settings);
  } else {
    const settings = buildHookSettings({
      pluginDir,
      socketPath: ipcSocketPath,
      nodePath,
    });
    settingsFile = writeHookSettingsFile(settings);
    extraEnv.GRYPHON_PERMISSION_SOCKET = ipcSocketPath;
    // Issue #33: identify this hook spawn's parent CLI to the plugin
    // (parallel to codex-cli + gemini-cli adapters). On a protected
    // deny, the plugin marks claude-code for force-fresh next spawn,
    // robust to session_id mismatches between the hook input and
    // the provider's stored sessionId.
    extraEnv.GRYPHON_HOOK_PROVIDER = KIND;
  }

  const cleanup = () => {
    if (!settingsFile) return;
    try {
      if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    } catch (e) {
      console.warn(`[gryphon/hook-adapter] failed to remove ${settingsFile}: ${e.message}`);
    }
    settingsFile = null;
  };

  return {
    env: extraEnv,
    args: ["--settings", settingsFile],
    cleanup,
    settingsFile,  // exposed for diagnostics (see existing claude-code debug logging)
  };
}

module.exports = { kind: KIND, buildSpawnExtras };
