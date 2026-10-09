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
 * Issues #30 / R43-7: degraded protection is a visible notice, not a console
 * line — once per (kind, situation) per process, through the host's adapter
 * (the chat view supplies one for every host, embedders included).
 */
const _degradedNoticed = new Set<string>();
function _cliLabel(kind: string): string {
  return kind === "codex-cli" ? "Codex" : kind === "gemini-cli" ? "Gemini CLI" : kind === "antigravity-cli" ? "Antigravity" : kind;
}
function _notify(options: Record<string, unknown>, key: string, msg: string) {
  if (_degradedNoticed.has(key)) return;
  _degradedNoticed.add(key);
  const ha = options && (options.hostAdapter as { notify?: (m: string, o?: unknown) => void } | undefined);
  try { ha?.notify?.(msg, { level: "warn", timeoutMs: 15000 }); } catch (_) { /* a notice must not break a spawn */ }
}
function _noticeStoreGuardDegraded(kind: string, reason: string, options: Record<string, unknown>) {
  // Review: Antigravity refuses to start without this check (except when
  // Node.js is missing) and says why itself; a notice saying it runs
  // unguarded would contradict that refusal.
  if (kind === "antigravity-cli" && reason !== "no node binary found") {
    console.warn(`[gryphon/hooks] store guard unavailable for ${kind}: ${reason}`);
    return;
  }
  const label = _cliLabel(kind);
  // QA (2.11.2): a launcher refusal names its own cause and fix here too.
  const refusal = launcherRefusalText(reason);
  const why = refusal ? `Gryphon couldn't set up its check for ${label} (${refusal.cause})` : reason === "no node binary found"
    ? "Gryphon couldn't find Node.js on this computer"
    : reason === "store-guard script unavailable"
      ? `Gryphon couldn't write to its settings folder (${approvalsDir()})`
      : `Gryphon couldn't install its check for ${label}`;
  const msg =
    `${why}, so it can't stop ${label} from changing Gryphon's own security settings. ` +
    "Gryphon still undoes such changes when each reply ends. " +
    (refusal ? refusal.fix : reason === "no node binary found"
      ? "Install Node.js (or add it to your PATH) and restart Obsidian to restore the check."
      : reason === "store-guard script unavailable"
        ? "Make that folder writable and restart Obsidian to restore the check."
        : "Check that the CLI's settings files are valid and writable, then start a new chat.");
  console.warn(`[gryphon/hooks] store guard unavailable for ${kind}: ${reason}`);
  _notify(options, `sg:${kind}:${reason}`, msg);
}
/**
 * Plain-language cause for a user notice (R44 D1): internal reasons such as
 * "ipc server not listening" or adapter errors stay in the console.
 */
/** QA P2-B: an adapter's own reason for refusing, when it gives one. */
function _refusalOf(adapter: any): string {
  try {
    const r = adapter && typeof adapter.lastRefusal === "function" ? adapter.lastRefusal() : null;
    return r ? ` (refused: ${r})` : "";
  } catch (_) { return ""; }
}

const { launcherRefusalText } = require("../../provider-runtime/dist/launcher-refusal-text");

function _plainCause(reason: string): string {
  const refusal = launcherRefusalText(reason);
  if (refusal) return refusal.cause;
  if (/ipc server/i.test(reason)) return "Gryphon's approval service isn't running";
  if (/plugin dir|hook scripts missing/i.test(reason)) return "some of Gryphon's files are missing";
  if (/node binary/i.test(reason)) return "Node.js wasn't found on this computer";
  return "Gryphon couldn't set its checks up";
}

/** QA P2-2: the fix that matches the cause (a restart doesn't fix them all). */
function _restoreHint(reason: string): string {
  const refusal = launcherRefusalText(reason);
  if (refusal) return refusal.fix;
  if (/plugin dir|hook scripts missing/i.test(reason)) return "Reinstall or update Gryphon to restore them — a sync tool may have renamed its files.";
  if (/node binary/i.test(reason)) return "Install Node.js (or add it to your PATH) and restart Obsidian to restore them.";
  return "Restart Obsidian to restore the checks.";
}

/** R43-7: Protected Mode is on but the full checks can't run for this CLI. */
function _noticeFullDegraded(kind: string, reason: string, fallbackOk: boolean, options: Record<string, unknown>) {
  const label = _cliLabel(kind);
  const msg =
    `Protected Mode is on, but Gryphon's checks for ${label} aren't running (${_plainCause(reason)}), ` +
    "so protected files and commands won't ask for approval in this chat. " +
    (fallbackOk
      ? `${label} still can't change Gryphon's own security settings. `
      : `${label} could also change Gryphon's own security settings; Gryphon undoes such changes when each reply ends. `) +
    _restoreHint(reason);
  console.warn(`[gryphon/hooks] full hooks unavailable for ${kind}: ${reason} (store-guard fallback ${fallbackOk ? "on" : "off"})`);
  // R44 SF-4: the fallback's outcome is part of the key — losing the store
  // guard later must not hide behind the earlier "still protected" notice.
  _notify(options, `full:${kind}:${reason}:${fallbackOk ? "sg" : "nosg"}`, msg);
}

/** Store-guard-only extras for `kind`, or why they couldn't be built. */
function _storeGuardExtras(kind: string, adapter: any, nodePath: string | null, options: Record<string, unknown>):
  { ok: true; extras: any; scriptPath: string } | { ok: false; reason: string } {
  if (!nodePath) return { ok: false, reason: "no node binary found" };
  const sg = ensureStoreGuardScript();
  if (!sg.ok) return { ok: false, reason: "store-guard script unavailable" };
  let extras;
  try {
    extras = adapter.buildSpawnExtras({ nodePath, options, storeGuardOnly: { scriptPath: sg.path, approvalsDir: approvalsDir() } });
  } catch (e) {
    return { ok: false, reason: `adapter.buildSpawnExtras threw: ${(e as Error).message}` };
  }
  if (!extras) return { ok: false, reason: `adapter "${kind}" couldn't install the store-guard hook${_refusalOf(adapter)}` };
  return { ok: true, extras, scriptPath: sg.path };
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
  // R43-7: Protected Mode on but the full checks can't run (checker not
  // listening, plugin dir/scripts missing, adapter failure) — a CLI other
  // than claude-code keeps at least the store guard, and the user is told.
  const fullFallback = (reason: string, details: unknown, extra: Record<string, unknown> = {}) => {
    // claude-code has its own offline notice; antigravity refuses to start
    // on a fallback (it can't run without auto-approve), so installing a
    // hook into the user's global agy config first would be pointless.
    if (kind === "claude-code" || kind === "antigravity-cli") {
      return { ...empty, degradationReason: reason, details, mode: "full", ...extra };
    }
    const built = _storeGuardExtras(kind, adapter, pf.nodePath, options);
    _noticeFullDegraded(kind, reason, built.ok, options);
    if (!built.ok) return { ...empty, degradationReason: reason, details, mode: "full", ...extra };
    return {
      ok: true,
      mode: "store-guard-fallback",
      env: built.extras.env || {},
      args: built.extras.args || [],
      cleanup: built.extras.cleanup || (() => {}),
      degradationReason: reason,
      details,
      missing: [],
      settingsFile: built.extras.settingsFile,
      ...extra,
    };
  };
  if (!pf.ok) {
    if (pf.mode === "store-guard-only") {
      _noticeStoreGuardDegraded(kind, String(pf.reason), options);
      return { ...empty, degradationReason: pf.reason, details: pf.details, mode: pf.mode };
    }
    return fullFallback(String(pf.reason), pf.details);
  }

  if (pf.mode === "store-guard-only") {
    const built = _storeGuardExtras(kind, adapter, pf.nodePath, options);
    if (!built.ok) {
      _noticeStoreGuardDegraded(kind, built.reason, options);
      return { ...empty, degradationReason: built.reason, details: pf.details, mode: pf.mode };
    }
    // #35 sibling (review): the store guard is back — a later loss of it
    // in this session must be reported again too.
    for (const k of [..._degradedNoticed]) if (k.startsWith(`sg:${kind}:`)) _degradedNoticed.delete(k);
    const extras = built.extras;
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
    return fullFallback("hook scripts missing on disk", pf.details, { missing });
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
    return fullFallback(`adapter.buildSpawnExtras threw: ${(e as Error).message}`, pf.details);
  }

  if (!extras) {
    // Adapter returned null defensively (e.g. missing pluginDir /
    // ipcSocketPath / nodePath). Pre-flight above should have caught
    // these cases — if we reach here, it indicates pre-flight is
    // out of sync with adapter expectations. Surface a useful
    // diagnostic rather than the legacy "Stage 2/3 pending" copy.
    return fullFallback(
      `adapter "${kind}" returned null${_refusalOf(adapter)} (pre-flight should have caught the missing input — ` +
      `check pluginDir, ipcSocketPath, nodePath)`,
      pf.details,
    );
  }

  // #35 (QA P3-2): full protection is back for this CLI — a later
  // degradation in the same session must be reported again.
  for (const k of [..._degradedNoticed]) if (k.startsWith(`full:${kind}:`)) _degradedNoticed.delete(k);
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
