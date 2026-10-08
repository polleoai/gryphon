// TypeScript module marker.

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
 *
 * Two modes (issue #30):
 *   full             — Protected Mode on. Needs the IPC server, the plugin
 *                      dir, node and every hook script; installs them all.
 *   store-guard-only — Protected Mode off, codex / gemini / antigravity.
 *                      Needs only node and the materialized store-guard
 *                      script (see store-guard.ts). Installs one deny-only
 *                      PreToolUse / BeforeTool hook that refuses writes to
 *                      Gryphon's own trust stores. No IPC, no plugin dir,
 *                      so it works in an embedder that ships main.js only.
 *                      claude-code keeps its permissions.deny globs instead.
 */

const path = require("path") as typeof import("path");
const fs = require("fs") as typeof import("fs");
const runtimeUtils = require("../../provider-runtime/dist/utils");
const { getAdapter, listSupportedKinds } = require("./hook-adapters");
const { securityInputsOf } = require("./security-settings-store");
const { ensureStoreGuardScript } = require("./store-guard");
const { approvalsDir } = require("./mcp-approvals");
const { HOOK_FILES } = require("../../provider-runtime/dist/providers/claude-code/hook-settings-builder");

function _protectedModeOn(plugin: Record<string, unknown> | null | undefined, security?: Record<string, unknown> | null): boolean {
  // The spawn's security snapshot. Without one, securityInputsOf returns the
  // protected defaults — never the vault's data.json (issue #30, G4).
  return securityInputsOf({ security, plugin }).protectedMode !== false;
}

/**
 * Run pre-flight diagnostics. Returns `{ ok, mode, reason, details,
 * nodePath, storeGuardScript? }`. `details` is the per-component breakdown
 * so a debug log can show exactly which check failed (matches the existing
 * claude-code `hookPreflight` shape).
 *
 * Protected Mode on → mode "full" (IPC + plugin dir + node). Off → mode
 * "store-guard-only": node + a verified store-guard script, and nothing
 * else — `ipcServer` and `absolutePluginDir` are not consulted.
 */
function _preflight(plugin: Record<string, unknown> | null | undefined, security?: Record<string, unknown> | null) {
  const protectedModeOn = _protectedModeOn(plugin, security);
  const nodePath = runtimeUtils.findNodeBinary();
  const hasNodeBinary = !!nodePath;

  if (!protectedModeOn) {
    const details: Record<string, unknown> = { protectedModeOn, hasNodeBinary, storeGuardScript: null, storeGuardOk: false };
    const mode = "store-guard-only";
    if (!hasNodeBinary) {
      return { ok: false, mode, reason: "no node binary found", details, nodePath };
    }
    const sg = ensureStoreGuardScript();
    details.storeGuardOk = sg.ok;
    if (!sg.ok) {
      details.storeGuardError = sg.reason;
      return { ok: false, mode, reason: "store-guard script unavailable", details, nodePath };
    }
    details.storeGuardScript = sg.path;
    return { ok: true, mode, reason: null, details, nodePath, storeGuardScript: sg.path };
  }

  const hasIpcServer = !!(plugin && plugin.ipcServer);
  const ipcServer = plugin && (plugin.ipcServer as Record<string, unknown>);
  const ipcServerListening = !!(ipcServer && typeof ipcServer.isListening === "function" && ipcServer.isListening());
  const hasAbsolutePluginDir = !!(plugin && typeof plugin.absolutePluginDir === "function" && (plugin.absolutePluginDir as () => unknown)());

  const details = {
    protectedModeOn,
    hasIpcServer,
    ipcServerListening,
    hasAbsolutePluginDir,
    hasNodeBinary,
  };
  const mode = "full";

  if (!hasIpcServer || !ipcServerListening) {
    return { ok: false, mode, reason: "ipc server not listening", details, nodePath };
  }
  if (!hasAbsolutePluginDir) {
    return { ok: false, mode, reason: "plugin dir not resolvable", details, nodePath };
  }
  if (!hasNodeBinary) {
    return { ok: false, mode, reason: "no node binary found", details, nodePath };
  }
  return { ok: true, mode, reason: null, details, nodePath };
}

/**
 * Issue #30: a store-guard that can't install is a visible degradation, not
 * a console line. One notice per reason per process, through the host's
 * adapter (the chat view's ObsidianHostAdapter, or any embedder's).
 */
const _storeGuardNoticed = new Set<string>();
function _noticeStoreGuardDegraded(kind: string, reason: string, options: Record<string, unknown>) {
  const label = kind === "codex-cli" ? "Codex" : kind === "gemini-cli" ? "Gemini CLI" : kind === "antigravity-cli" ? "Antigravity" : kind;
  const why = reason === "no node binary found"
    ? "Gryphon couldn't find Node.js on this computer"
    : `Gryphon couldn't write to its settings folder (${approvalsDir()})`;
  const msg =
    `${why}, so with Protected Mode off it can't install the check that stops ${label} ` +
    "from changing Gryphon's own security settings. Gryphon still undoes such changes " +
    "when each reply ends. " +
    (reason === "no node binary found"
      ? "Install Node.js (or add it to your PATH) and restart Obsidian to restore the check."
      : "Make that folder writable and restart Obsidian to restore the check.");
  console.warn(`[gryphon/hooks] store guard unavailable for ${kind}: ${reason}`);
  if (_storeGuardNoticed.has(reason)) return;
  _storeGuardNoticed.add(reason);
  const ha = options && (options.hostAdapter as { notify?: (m: string, o?: unknown) => void } | undefined);
  try { ha?.notify?.(msg, { level: "warn", timeoutMs: 15000 }); } catch (_) { /* a notice must not break a spawn */ }
}

/**
 * Verify every hook script the adapter will reference actually exists
 * on disk. Returns a list of missing files; empty list = all good.
 *
 * Catches the cloud-sync conflict-rename case (iCloud/OneDrive/Dropbox/
 * Syncthing renaming the `hooks/` folder to `hooks 2/` on conflict) at
 * pre-flight rather than at first hook fire.
 */
function _verifyHookScripts(pluginDir: string): string[] {
  const hookDir = path.join(pluginDir, "hooks");
  const missing = [];
  for (const scriptName of Object.values(HOOK_FILES)) {
    const p = path.join(hookDir, String(scriptName));
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
function prepareSpawn({ kind, plugin, options = {} }: { kind: string; plugin: Record<string, unknown> | null | undefined; options?: Record<string, unknown> }) {
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

  const security = options && (options.security as Record<string, unknown> | null | undefined);
  // claude-code with Protected Mode off keeps its permissions.deny globs
  // (buildApprovalsStoreDenyGlobs) — it never gets the store-guard hook.
  if (kind === "claude-code" && !_protectedModeOn(plugin, security)) {
    return { ...empty, degradationReason: "protectedMode is off", details: { protectedModeOn: false }, mode: null };
  }

  const pf = _preflight(plugin, security);
  if (!pf.ok) {
    if (pf.mode === "store-guard-only") _noticeStoreGuardDegraded(kind, String(pf.reason), options);
    return { ...empty, degradationReason: pf.reason, details: pf.details, mode: pf.mode };
  }

  if (pf.mode === "store-guard-only") {
    let extras;
    try {
      extras = adapter.buildSpawnExtras({
        nodePath: pf.nodePath,
        options,
        storeGuardOnly: { scriptPath: pf.storeGuardScript, approvalsDir: approvalsDir() },
      });
    } catch (e) {
      return { ...empty, degradationReason: `adapter.buildSpawnExtras threw: ${(e as Error).message}`, details: pf.details, mode: pf.mode };
    }
    if (!extras) {
      return { ...empty, degradationReason: `adapter "${kind}" couldn't install the store-guard hook`, details: pf.details, mode: pf.mode };
    }
    return {
      ok: true,
      mode: pf.mode,
      env: extras.env || {},
      args: extras.args || [],
      cleanup: extras.cleanup || (() => {}),
      degradationReason: null,
      details: pf.details,
      missing: [],
      settingsFile: extras.settingsFile,
    };
  }

  const pluginDir = (plugin as Record<string, unknown> & { absolutePluginDir: () => string }).absolutePluginDir();
  const missing = _verifyHookScripts(pluginDir);
  if (missing.length > 0) {
    return {
      ...empty,
      degradationReason: "hook scripts missing on disk",
      details: pf.details,
      missing,
    };
  }

  const ipcSocketPath = ((plugin as Record<string, unknown> & { ipcServer: { socketPath: () => string } }).ipcServer).socketPath();

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
      degradationReason: `adapter.buildSpawnExtras threw: ${(e as Error).message}`,
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
    mode: pf.mode,
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
function preparePermissionsFallback({ kind, plugin, denyGlobs }: { kind: string; plugin: Record<string, unknown>; denyGlobs: string[] }) {
  if (kind !== "claude-code") return null;
  const adapter = getAdapter(kind);
  if (!adapter) return null;
  try {
    const extras = adapter.buildSpawnExtras({
      pluginDir: (plugin as Record<string, unknown> & { absolutePluginDir: () => string }).absolutePluginDir(),
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
