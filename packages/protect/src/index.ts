// TypeScript module marker.

// Public API for @gryphon/protect.
//
// summariseArgs — module-level pure helper used by the S3 audit sink.
// Produces a short human-readable string from a tool args object.
// Deliberately defensive: no input shape should cause it to throw.

// Field names whose values are always redacted in the audit summary —
// these often carry secrets (file content, tokens, keys, passwords).
// REDACTED_FIELD_NAMES is module-scope (not inside the function) so
// it's allocated once, not on every call.
const REDACTED_FIELD_NAMES = new Set([
  "new_string", "old_string", "content", "new_content", "old_content",
  "body", "data", "secret", "token", "password", "api_key", "apiKey",
]);

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const out = [];
  try {
    for (const [key, val] of Object.entries(args)) {
      if (REDACTED_FIELD_NAMES.has(key)) {
        out.push(`${key}=[redacted]`);
        continue;
      }
      if (typeof val === "string") {
        const truncated = val.length > 80 ? val.slice(0, 77) + "..." : val;
        out.push(`${key}=${truncated}`);
      } else if (typeof val === "number" || typeof val === "boolean") {
        out.push(`${key}=${val}`);
      } else if (val === null) {
        out.push(`${key}=null`);
      } else if (val === undefined) {
        out.push(`${key}=[undefined]`);
      } else {
        out.push(`${key}=[${Array.isArray(val) ? "array" : typeof val}]`);
      }
    }
  } catch (_) {
    // Hostile or unusual args — return whatever we built so far.
  }
  return out.join(" ");
}


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
 * Accepts two call forms — legacy and headless — which are additively
 * combined so existing callers are unaffected:
 *
 *   Legacy:   createProtectionContext({ plugin, settings })
 *   Headless: createProtectionContext({ config, hostAdapter?, onDecision? })
 *
 * @param {object} args
 *   plugin      — host plugin instance (Obsidian plugin shell)
 *   settings    — settings snapshot (falls back to plugin.settings)
 *   config      — headless config (replaces settings for non-plugin callers;
 *                 merged as _settings when plugin/settings are absent)
 *   hostAdapter — HostAdapter instance; defaults to HeadlessHostAdapter
 *                 when omitted. Controls notify() and fetch() surface.
 *   onDecision  — audit sink (S3). Called synchronously after every gate
 *                 decision with {ts, tool, args_summary, decision, reason}.
 *                 Sink errors are isolated: surfaced via hostAdapter.notify
 *                 (warn level) but never block the decision or propagate up.
 *
 * @returns {{
 *   prepareSpawn:  ({kind, cwd, providerOptions}) => object | null,
 *   classify:      ({toolName, toolInput, vaultRoot, toolUseId}) => null | object,
 *   isAvailable:   () => boolean,
 *   decide:        ({tool, args, mode, scope}) => Promise<{decision: "allow"|"deny", reason: string|null}>,
 * }}
 *
 * Note: `classify` returns `null` when the call shouldn't be gated;
 * otherwise an object whose `.kind` is `"protected"` / `"protected-exec"` /
 * `"fileEdit"` / `"exec"` and `.category` names the matched rule (e.g.
 * `"destructive-operation"`). Callers that want a binary allow/deny
 * pass the structured result to `permissionGate.checkPermission`.
 *
 * `decide()` is the headless gate entry. It normalises the classifier's
 * null → allow and routes non-null results through permissionGate,
 * mapping the existing {allow, reason} shape to the public
 * {decision, reason} contract. Returns a Promise — callers should await it.
 * In fully headless contexts (no plugin.app) the promise resolves
 * synchronously (microtask) since the no-modal fallback path in
 * checkPermission is a plain synchronous return.
 */
function createProtectionContext({
  plugin,
  settings,
  config,
  hostAdapter,
  onDecision,
}: {
  plugin?: any;
  settings?: any;
  config?: any;
  hostAdapter?: any;
  onDecision?: ((...args: any[]) => any) | null;
} = {}) {
  const _settings = config || settings || (plugin && plugin.settings) || {};
  const _hostAdapter = hostAdapter || new (require("./host-adapter").HeadlessHostAdapter)();

  return {
    prepareSpawn({ kind, cwd, providerOptions = {} }: { kind: string; cwd?: string; providerOptions?: Record<string, unknown> }) {
      // Delegate to the existing hook-dispatcher entry. Its signature
      // expects `{ kind, plugin, options }` — `cwd` rides inside options.
      const merged = { ...providerOptions, cwd };
      return hookDispatcher.prepareSpawn({
        kind,
        plugin,
        options: merged,
      });
    },

    classify({ toolName, toolInput, vaultRoot, toolUseId }: { toolName: string; toolInput: Record<string, unknown> | null; vaultRoot?: string | null; toolUseId?: string }) {
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
        { plugin, settings: _settings, vaultRoot, hostAdapter: _hostAdapter },
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
        console.error("[gryphon/protect] ipcServer.isListening threw — protection disabled:", e && (e as Error).message);
        return false;
      }
    },

    /**
     * Callable gate API — the primary entry for headless consumers (Peitho,
     * CLI hosts, tests). Classify the proposed tool call and return a
     * structured allow/deny decision without any UI interaction.
     *
     * @param {object} opts
     *   tool  — raw tool name (provider-specific; e.g. "bash", "read_file")
     *   args  — tool input object (same shape as tool_use.input)
     *   mode  — permission mode override ("default"|"acceptEdits"|"bypassPermissions"|"plan");
     *           falls back to _settings.permissionMode, then "default"
     *   scope — { allowedRoots?: string[] } — vaultRoot is taken as scope.allowedRoots[0]
     *           for path classification
     *
     * @returns {Promise<{decision: "allow"|"deny", reason: string|null}>}
     *
     * Implementation notes:
     *   - classify() returns null for read-only tools (Read/Glob/Grep) and for
     *     tools whose protection toggle is off → fast-path to {decision:"allow"}.
     *   - For protected matches, checkPermission is called with a headless ctx
     *     (no plugin.app). Its no-modal fallback returns {allow:false} synchronously
     *     (the promise resolves in the next microtask with no I/O).
     *   - "prompt" decision is not surfaced today: in headless contexts,
     *     "would have prompted" collapses to "deny" (the no-plugin.app fallback
     *     in checkPermission fires before any modal path is reached). A future
     *     refactor can split these once the modal path is HostAdapter-injected.
     *     TODO(Phase-1-follow-up): surface {decision:"prompt"} when checkPermission
     *     can signal intent before falling back, without modifying permission-gate.
     */
    async decide({ tool, args, mode, scope }: { tool: string; args: Record<string, unknown>; mode?: string; scope?: { allowedRoots?: string[] } }) {
      const vaultRoot = scope && Array.isArray(scope.allowedRoots) && scope.allowedRoots[0]
        ? scope.allowedRoots[0]
        : null;

      const classifyResult = attackDetector.classify(
        tool,
        args,
        { plugin, settings: _settings, vaultRoot, hostAdapter: _hostAdapter },
      );

      // classify() returns null when the call is not gated — read-only
      // tools, toggles off, or tool type not covered. Fast-path allow.
      if (classifyResult === null || classifyResult === undefined) {
        const fastResult = { decision: "allow", reason: null };
        if (onDecision) {
          try {
            onDecision({
              ts: Date.now(),
              tool,
              args_summary: summariseArgs(args),
              decision: fastResult.decision,
              reason: fastResult.reason,
            });
          } catch (e) {
            // Sink errors are isolation failures — surface to host adapter but
            // never block the decision. Consumers can implement their own retry
            // by buffering inside the sink.
            if (_hostAdapter && _hostAdapter.notify) {
              try {
                _hostAdapter.notify(`audit sink threw: ${(e as Error).message}`, { level: "warn" });
              } catch (_) { /* notify must not block either */ }
            }
          }
        }
        return fastResult;
      }

      // Non-null classification: route through checkPermission.
      // checkPermission expects a named-args object with a `ctx` property
      // (not positional args as the plan's skeleton assumed). The `ctx` shape
      // that checkPermission reads: { permissionMode, plugin, plugin.settings,
      // plugin.app }. In headless mode plugin is absent → the no-modal early
      // return fires: { allow: false, reason: "Cannot prompt user..." }.
      const effectiveMode = mode || _settings.permissionMode || "default";
      const canonical = attackDetector.normalizeToolName(tool);
      const isBash = canonical === "Bash" || canonical === "PowerShell";
      const kind = isBash ? "protected-exec" : "protected";
      const action = isBash ? "run" : "write";
      const target = isBash
        ? (args && typeof args.command === "string" ? args.command : String(tool))
        : (args && (args.file_path || args.path) ? (args.file_path || args.path) : String(tool));

      const headlessCtx = {
        permissionMode: effectiveMode,
        plugin,   // null/undefined in fully headless callers → no-modal path
      };

      let gateResult;
      try {
        gateResult = await permissionGate.checkPermission({
          ctx: headlessCtx,
          action,
          target,
          detail: classifyResult.technicalDetail || null,
          kind,
          cacheable: false,
          warning: classifyResult.userRisk,
          category: classifyResult.category,
          categoryTitle: classifyResult.title,
        });
      } catch (gateErr) {
        const errorResult = { decision: "deny", reason: `gate-error: ${(gateErr as Error).message}` };
        if (onDecision) {
          try {
            onDecision({
              ts: Date.now(),
              tool,
              args_summary: summariseArgs(args),
              decision: errorResult.decision,
              reason: errorResult.reason,
            });
          } catch (_) { /* sink err */ }
        }
        return errorResult;
      }

      // permissionGate returns { allow: bool, reason: string }.
      // Map to the public { decision, reason } contract.
      const decision = gateResult.allow ? "allow" : "deny";
      const result = {
        decision,
        reason: gateResult.reason || classifyResult.category || null,
      };

      if (onDecision) {
        try {
          onDecision({
            ts: Date.now(),
            tool,
            args_summary: summariseArgs(args),
            decision: result.decision,
            reason: result.reason,
          });
        } catch (e) {
          // Sink errors are isolation failures — surface to host adapter but
          // never block the decision. Consumers can implement their own retry
          // by buffering inside the sink.
          if (_hostAdapter && _hostAdapter.notify) {
            try {
              _hostAdapter.notify(`audit sink threw: ${(e as Error).message}`, { level: "warn" });
            } catch (_) { /* notify must not block either */ }
          }
        }
      }

      return result;
    },
  };
}
