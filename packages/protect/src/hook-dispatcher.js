/**
 * HookDispatcher — central orchestrator for pre/post-tool-use hooks
 * across every CLI provider Gryphon integrates with.
 *
 * Architectural responsibilities:
 *   1. Pre-flight: confirm the IPC server is up, the plugin dir is
 *      resolvable, and a real node binary is locatable. If anything
 *      fails, return a degraded result (provider falls back to its
 *      legacy enforcement path or runs unprotected with a clear notice).
 *   2. Adapter selection: look up the per-provider adapter and call
 *      its `buildSpawnExtras` to translate the canonical hook config
 *      into provider-specific spawn artifacts (env vars, CLI args,
 *      cleanup function).
 *   3. Cleanup: every spawn produces a tmp config file (or directory)
 *      that must be removed when the CLI exits. The dispatcher returns
 *      a single `cleanup()` function the provider invokes on close.
 *
 * Why a singleton-style API instead of an instance per provider:
 *   - The IPC server itself is already a singleton owned by the plugin
 *     lifecycle (created in onload, closed in onunload). Every provider
 *     reuses it. Making the dispatcher stateless and reading the
 *     plugin's IPC server on each call mirrors that ownership.
 *   - Tests patch `process.execPath` and the binary detectors at
 *     runtime; a stateless dispatcher picks up those changes per call
 *     without cache-invalidation footguns.
 *
 * The hook scripts (hooks/pretool.js etc.) are provider-agnostic —
 * they read JSON from stdin, talk to the IPC server, write JSON to
 * stdout. This dispatcher is just the wiring layer between a CLI's
 * spawn-time config surface and Gryphon's existing decision pipeline.
 */

const path = require("path");
const fs = require("fs");
const { findNodeBinary } = require("../../provider-runtime/src/utils");
const { getAdapter, listSupportedKinds } = require("./hook-adapters");
const { HOOK_FILES } = require("../../provider-runtime/src/providers/claude-code/hook-settings-builder");

/**
 * Run pre-flight diagnostics. Returns `{ ok, reason, details }`.
 * `details` is the per-component breakdown so a debug log can show
 * exactly which check failed (matches the existing claude-code
 * `hookPreflight` shape).
 */
function _preflight(plugin) {
  const settings = (plugin && plugin.settings) || {};
  const protectedModeOn = settings.protectedMode !== false;
  const hasIpcServer = !!(plugin && plugin.ipcServer);
  const ipcServerListening = !!(plugin && plugin.ipcServer && plugin.ipcServer.isListening());
  const hasAbsolutePluginDir = !!(plugin && typeof plugin.absolutePluginDir === "function" && plugin.absolutePluginDir());
  const nodePath = findNodeBinary();
  const hasNodeBinary = !!nodePath;

  const details = {
    protectedModeOn,
    hasIpcServer,
    ipcServerListening,
    hasAbsolutePluginDir,
    hasNodeBinary,
  };

  if (!protectedModeOn) {
    return { ok: false, reason: "protectedMode is off", details, nodePath };
  }
  if (!hasIpcServer || !ipcServerListening) {
    return { ok: false, reason: "ipc server not listening", details, nodePath };
  }
  if (!hasAbsolutePluginDir) {
    return { ok: false, reason: "plugin dir not resolvable", details, nodePath };
  }
  if (!hasNodeBinary) {
    return { ok: false, reason: "no node binary found", details, nodePath };
  }
  return { ok: true, reason: null, details, nodePath };
}

/**
 * Verify every hook script the adapter will reference actually exists
 * on disk. Returns a list of missing files; empty list = all good.
 *
 * Catches the cloud-sync conflict-rename case (iCloud/OneDrive/Dropbox/
 * Syncthing renaming the `hooks/` folder to `hooks 2/` on conflict) at
 * pre-flight rather than at first hook fire.
 */
function _verifyHookScripts(pluginDir) {
  const hookDir = path.join(pluginDir, "hooks");
  const missing = [];
  for (const scriptName of Object.values(HOOK_FILES)) {
    const p = path.join(hookDir, scriptName);
    if (!fs.existsSync(p)) missing.push(p);
  }
  const ipcHelper = path.join(hookDir, "common", "ipc-client.js");
  if (!fs.existsSync(ipcHelper)) missing.push(ipcHelper);
  return missing;
}

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
function prepareSpawn({ kind, plugin, options = {} }) {
  // Empty result shape — providers can always merge env/args even when
  // we couldn't wire hooks (just nothing to merge).
  const empty = { ok: false, env: {}, args: [], cleanup: () => {}, details: {}, missing: [] };

  const adapter = getAdapter(kind);
  if (!adapter) {
    return {
      ...empty,
      degradationReason: `no hook adapter for kind="${kind}" (supported: ${listSupportedKinds().join(", ")})`,
    };
  }

  const pf = _preflight(plugin);
  if (!pf.ok) {
    return { ...empty, degradationReason: pf.reason, details: pf.details };
  }

  const pluginDir = plugin.absolutePluginDir();
  const missing = _verifyHookScripts(pluginDir);
  if (missing.length > 0) {
    return {
      ...empty,
      degradationReason: "hook scripts missing on disk",
      details: pf.details,
      missing,
    };
  }

  const ipcSocketPath = plugin.ipcServer.socketPath();

  let extras;
  try {
    extras = adapter.buildSpawnExtras({
      pluginDir,
      ipcSocketPath,
      nodePath: pf.nodePath,
      options,
    });
  } catch (e) {
    return {
      ...empty,
      degradationReason: `adapter.buildSpawnExtras threw: ${e.message}`,
      details: pf.details,
    };
  }

  if (!extras) {
    // Adapter returned null defensively (e.g. missing pluginDir /
    // ipcSocketPath / nodePath). Pre-flight above should have caught
    // these cases — if we reach here, it indicates pre-flight is
    // out of sync with adapter expectations. Surface a useful
    // diagnostic rather than the legacy "Stage 2/3 pending" copy.
    return {
      ...empty,
      degradationReason:
        `adapter "${kind}" returned null (pre-flight should have caught the missing input — ` +
        `check pluginDir, ipcSocketPath, nodePath)`,
      details: pf.details,
    };
  }

  return {
    ok: true,
    env: extras.env || {},
    args: extras.args || [],
    cleanup: extras.cleanup || (() => {}),
    degradationReason: null,
    details: pf.details,
    missing: [],
    settingsFile: extras.settingsFile, // optional; carried for debug-log compatibility
  };
}

/**
 * Convenience: build a permissions-only fallback (deny-list only, no
 * hooks) for the claude-code path when full hook installation fails
 * pre-flight. Other providers don't have an equivalent fallback today;
 * the dispatcher just returns null for them.
 */
function preparePermissionsFallback({ kind, plugin, denyGlobs }) {
  if (kind !== "claude-code") return null;
  const adapter = getAdapter(kind);
  if (!adapter) return null;
  try {
    const extras = adapter.buildSpawnExtras({
      pluginDir: plugin.absolutePluginDir(),
      ipcSocketPath: "",
      nodePath: "",
      permissionsOnly: { denyGlobs },
    });
    return {
      ok: true,
      env: extras.env || {},
      args: extras.args || [],
      cleanup: extras.cleanup || (() => {}),
      settingsFile: extras.settingsFile,
    };
  } catch (e) {
    return { ok: false, error: e };
  }
}

module.exports = {
  prepareSpawn,
  preparePermissionsFallback,
  _preflight,         // exported for tests
  _verifyHookScripts, // exported for tests
};
