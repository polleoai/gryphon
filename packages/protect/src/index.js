// Public API for @gryphon/protect.
//
// Consumers (the plugin shell, future non-Obsidian hosts) should only
// import from this entry. Deep imports like `@gryphon/protect/src/X`
// will not work once this package ships as a dist-only npm tarball.
//
// Three shapes of export are offered, deliberately:
//   1. Namespace exports: each internal module is reachable as a top-level
//      property — `const { attackDetector } = require("@gryphon/protect")`.
//      Lets consumers use the whole module when they need many of its
//      named exports (e.g. tools/bash.js uses several attackDetector helpers).
//   2. Promoted named exports: the most frequently-used named bindings
//      (classify, buildDenyReason, PermissionIPCServer, etc.) are also
//      hoisted to the top level so consumers can destructure cleanly.
//   3. createProtectionContext({plugin, settings}) — the unified consumer
//      entry. Wraps prepareSpawn, classify, and availability checks behind
//      a single object the runtime layer can treat as opaque. This is the
//      contract a non-Obsidian consumer (CLI host, web app, custom plugin)
//      uses to inject protection without reaching for individual modules.

const attackDetector = require("./attack-detector");
const denyCopy = require("./deny-copy");
const permissionIpcServer = require("./permission-ipc-server");
const provenanceStore = require("./provenance-store");
const tmpfileSweeper = require("./tmpfile-sweeper");
const winSpawn = require("./win-spawn");
const hookDispatcher = require("./hook-dispatcher");
const ccDisallowTranslator = require("./cc-disallow-translator");
const systemPromptHints = require("./system-prompt-hints");
const injectionPatterns = require("./injection-patterns");
const untrustedFraming = require("./untrusted-framing");
const hookAdapters = require("./hook-adapters");
const pathUtils = require("./path-utils");
const permissionGate = require("./permission-gate");
const constants = require("./constants");

module.exports = {
  // Namespace exports — whole modules
  attackDetector,
  denyCopy,
  permissionIpcServer,
  provenanceStore,
  tmpfileSweeper,
  winSpawn,
  hookDispatcher,
  ccDisallowTranslator,
  systemPromptHints,
  injectionPatterns,
  untrustedFraming,
  hookAdapters,
  pathUtils,
  permissionGate,
  constants,

  // Promoted named exports — frequent destructure targets
  classify: attackDetector.classify,
  normalizeToolName: attackDetector.normalizeToolName,
  buildDenyReason: denyCopy.buildDenyReason,
  PermissionIPCServer: permissionIpcServer.PermissionIPCServer,
  defaultSocketPath: permissionIpcServer.defaultSocketPath,
  ProvenanceStore: provenanceStore.ProvenanceStore,
  sweepGryphonOrphans: tmpfileSweeper.sweepGryphonOrphans,
  buildDisallowedTools: ccDisallowTranslator.buildDisallowedTools,

  // Promoted from path-utils — heavily used by SDK tools (bash/edit/etc.)
  resolveVaultPath: pathUtils.resolveVaultPath,
  PathOutsideVaultError: pathUtils.PathOutsideVaultError,
  resolveActivePatterns: pathUtils.resolveActivePatterns,

  // Promoted from permission-gate
  checkPermission: permissionGate.checkPermission,

  // Promoted from constants — protected-pattern catalog data
  DEFAULT_PROTECTED_PATHS: constants.DEFAULT_PROTECTED_PATHS,
  DEFAULT_PROTECTED_COMMANDS: constants.DEFAULT_PROTECTED_COMMANDS,
  PROTECTED_CATEGORIES: constants.PROTECTED_CATEGORIES,

  // System-prompt hint constants — these are pure data, frequently
  // imported by name, so spread to top level alongside the namespace.
  ...systemPromptHints,

  // The unified consumer factory — build a protection context for a host
  // application. Keeps the wiring (which dispatcher, which IPC server,
  // which classifier) opaque from the runtime layer's perspective.
  createProtectionContext,
};

/**
 * Build a protection context — the opaque contract the runtime layer
 * uses to inject protection. A non-Obsidian consumer can call this with
 * a stub `plugin` object exposing only `{ settings, app, ipcServer }`.
 *
 * @param {object} args
 *   plugin   — host plugin instance (for settings + app + ipcServer access)
 *   settings — settings snapshot (passed in for testability; falls back
 *              to plugin.settings if omitted)
 *
 * @returns {{
 *   prepareSpawn:  ({kind, cwd, providerOptions}) => {ok, env, args, cleanup, details, missing, degradationReason} | null,
 *   classify:      ({toolName, toolInput, vaultRoot, toolUseId}) => null | {kind, category, ...},
 *   isAvailable:   () => boolean,
 * }}
 *
 * Note: `classify` returns `null` when the call shouldn't be gated;
 * otherwise an object whose `.kind` is `"protected"` / `"protected-exec"` /
 * `"fileEdit"` / `"exec"` and `.category` names the matched rule (e.g.
 * `"destructive-operation"`). Callers that want a binary allow/deny
 * pass the structured result to `permissionGate.checkPermission`.
 */
function createProtectionContext({ plugin, settings } = {}) {
  const _settings = settings || (plugin && plugin.settings) || {};

  return {
    prepareSpawn({ kind, cwd, providerOptions = {} }) {
      // Delegate to the existing hook-dispatcher entry. Its signature
      // expects `{ kind, plugin, options }` — `cwd` rides inside options.
      const merged = { ...providerOptions, cwd };
      return hookDispatcher.prepareSpawn({
        kind,
        plugin,
        options: merged,
      });
    },

    classify({ toolName, toolInput, vaultRoot, toolUseId }) {
      // attackDetector.classify is positional: (tool, input, ctx). The
      // ctx must carry plugin (for settings access), settings, and
      // vaultRoot (for protected-path resolution). The toolUseId is
      // observability-only — it doesn't shape the decision, so we
      // don't pass it down. Return whatever classify returns: null
      // when the call shouldn't be gated, or the structured kind/
      // category/etc. shape otherwise. Callers that want a binary
      // allow/deny should consult the `kind` field.
      return attackDetector.classify(
        toolName,
        toolInput,
        { plugin, settings: _settings, vaultRoot },
      );
    },

    isAvailable() {
      // Protection is "available" when settings allow it AND the host has
      // an IPC server we can register with. The host plugin exposes
      // `ipcServer` after onload completes.
      if (_settings.protectedMode === false) return false;
      if (!plugin || !plugin.ipcServer) return false;
      try {
        return plugin.ipcServer.isListening && plugin.ipcServer.isListening();
      } catch (e) {
        // isListening() should not throw under any documented
        // condition. If it does, that's a setup-level bug a non-
        // Obsidian consumer would want to know about — silently
        // returning false makes "protection is disabled" look
        // intentional rather than broken.
        console.error("[gryphon/protect] ipcServer.isListening threw — protection disabled:", e && e.message);
        return false;
      }
    },
  };
}
