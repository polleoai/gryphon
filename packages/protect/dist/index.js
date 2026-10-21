"use strict";
// TypeScript module marker.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureStoreGuardScript = exports.codexTrustOnlyOverlay = exports.patchTargets = exports.approvalsStoreVerdict = exports.CliPathRejectedError = exports.setMachineCliPath = exports.resolveCliPath = exports.EXECUTABLE_KEYS = exports.securityInputsOf = exports.effectiveSecuritySettings = exports.isWeakening = exports.dismissVaultSecuritySuggestion = exports.setMachineSecuritySetting = exports.readMachineSecuritySettings = exports.resolveSecurityScope = exports.SecurityScopeUnavailableError = exports.WEAKENING_KEYS = exports.setPermissionModalUi = exports.setActiveProviderKindResolver = exports.checkPermission = exports.resolveActivePatterns = exports.PathOutsideVaultError = exports.resolveVaultPath = exports.buildApprovalsStoreDenyGlobs = exports.buildDisallowedTools = exports.sweepGryphonOrphans = exports.ProvenanceStore = exports.defaultSocketPath = exports.PermissionIPCServer = exports.buildDenyReason = exports.normalizeToolName = exports.classify = exports.storeGuard = exports.securitySettings = exports.mcpApprovals = exports.constants = exports.permissionGate = exports.pathUtils = exports.hookAdapters = exports.untrustedFraming = exports.injectionPatterns = exports.systemPromptHints = exports.ccDisallowTranslator = exports.hookDispatcher = exports.winSpawn = exports.tmpfileSweeper = exports.provenanceStore = exports.permissionIpcServer = exports.denyCopy = exports.attackDetector = void 0;
exports.PROTECTED_CATEGORIES = exports.DEFAULT_PROTECTED_COMMANDS = exports.DEFAULT_PROTECTED_PATHS = exports.onSecurityStoreTamper = exports.checkSecurityStoreTamper = exports.snapshotSecurityStore = void 0;
exports.createProtectionContext = createProtectionContext;
// Public API for @polleoai/gryphon-protect.
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
function summariseArgs(args) {
    if (!args || typeof args !== "object")
        return "";
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
            }
            else if (typeof val === "number" || typeof val === "boolean") {
                out.push(`${key}=${val}`);
            }
            else if (val === null) {
                out.push(`${key}=null`);
            }
            else if (val === undefined) {
                out.push(`${key}=[undefined]`);
            }
            else {
                out.push(`${key}=[${Array.isArray(val) ? "array" : typeof val}]`);
            }
        }
    }
    catch {
        // Hostile or unusual args — return whatever we built so far.
    }
    return out.join(" ");
}
//
// Consumers (the plugin shell, future non-Obsidian hosts) should only
// import from this entry. Deep imports like `@polleoai/gryphon-protect/src/X`
// will not work once this package ships as a dist-only npm tarball.
//
// Three shapes of export are offered, deliberately:
//   1. Namespace exports: each internal module is reachable as a top-level
//      property — `const { attackDetector } = require("@polleoai/gryphon-protect")`.
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
const attackDetector = __importStar(require("./attack-detector"));
exports.attackDetector = attackDetector;
const denyCopy = __importStar(require("./deny-copy"));
exports.denyCopy = denyCopy;
const permissionIpcServer = __importStar(require("./permission-ipc-server"));
exports.permissionIpcServer = permissionIpcServer;
const provenanceStore = __importStar(require("./provenance-store"));
exports.provenanceStore = provenanceStore;
const tmpfileSweeper = __importStar(require("./tmpfile-sweeper"));
exports.tmpfileSweeper = tmpfileSweeper;
const winSpawn = __importStar(require("./win-spawn"));
exports.winSpawn = winSpawn;
const hookDispatcher = __importStar(require("./hook-dispatcher"));
exports.hookDispatcher = hookDispatcher;
const ccDisallowTranslator = __importStar(require("./cc-disallow-translator"));
exports.ccDisallowTranslator = ccDisallowTranslator;
const systemPromptHints = __importStar(require("./system-prompt-hints"));
exports.systemPromptHints = systemPromptHints;
const injectionPatterns = __importStar(require("./injection-patterns"));
exports.injectionPatterns = injectionPatterns;
const untrustedFraming = __importStar(require("./untrusted-framing"));
exports.untrustedFraming = untrustedFraming;
const hookAdapters = __importStar(require("./hook-adapters"));
exports.hookAdapters = hookAdapters;
const pathUtils = __importStar(require("./path-utils"));
exports.pathUtils = pathUtils;
const permissionGate = __importStar(require("./permission-gate"));
exports.permissionGate = permissionGate;
const constants = __importStar(require("./constants"));
exports.constants = constants;
const mcpApprovals = __importStar(require("./mcp-approvals"));
exports.mcpApprovals = mcpApprovals;
const storeGuard = __importStar(require("./store-guard"));
exports.storeGuard = storeGuard;
const tool_aliases_1 = require("./tool-aliases");
Object.defineProperty(exports, "patchTargets", { enumerable: true, get: function () { return tool_aliases_1.patchTargets; } });
const securitySettings = __importStar(require("./security-settings-store"));
exports.securitySettings = securitySettings;
const codex_cli_1 = require("./hook-adapters/codex-cli");
const host_adapter_1 = require("./host-adapter");
// Promoted named exports — frequent destructure targets
exports.classify = attackDetector.classify;
exports.normalizeToolName = attackDetector.normalizeToolName;
exports.buildDenyReason = denyCopy.buildDenyReason;
exports.PermissionIPCServer = permissionIpcServer.PermissionIPCServer;
exports.defaultSocketPath = permissionIpcServer.defaultSocketPath;
exports.ProvenanceStore = provenanceStore.ProvenanceStore;
exports.sweepGryphonOrphans = tmpfileSweeper.sweepGryphonOrphans;
exports.buildDisallowedTools = ccDisallowTranslator.buildDisallowedTools;
exports.buildApprovalsStoreDenyGlobs = ccDisallowTranslator.buildApprovalsStoreDenyGlobs;
// Promoted from path-utils — heavily used by SDK tools (bash/edit/etc.)
exports.resolveVaultPath = pathUtils.resolveVaultPath;
exports.PathOutsideVaultError = pathUtils.PathOutsideVaultError;
exports.resolveActivePatterns = pathUtils.resolveActivePatterns;
// Promoted from permission-gate
exports.checkPermission = permissionGate.checkPermission;
exports.setActiveProviderKindResolver = permissionGate.setActiveProviderKindResolver;
exports.setPermissionModalUi = permissionGate.setPermissionModalUi;
// Issue #29: machine-local security settings (store, scope, accessor).
exports.WEAKENING_KEYS = securitySettings.WEAKENING_KEYS;
exports.SecurityScopeUnavailableError = securitySettings.SecurityScopeUnavailableError;
exports.resolveSecurityScope = securitySettings.resolveSecurityScope;
exports.readMachineSecuritySettings = securitySettings.readMachineSecuritySettings;
exports.setMachineSecuritySetting = securitySettings.setMachineSecuritySetting;
exports.dismissVaultSecuritySuggestion = securitySettings.dismissVaultSecuritySuggestion;
exports.isWeakening = securitySettings.isWeakening;
exports.effectiveSecuritySettings = securitySettings.effectiveSecuritySettings;
exports.securityInputsOf = securitySettings.securityInputsOf;
// Issue #30: machine-scoped CLI binary paths — the one resolver every
// spawn and probe uses (sync, never throws, returns the realpath to
// spawn), and its write API.
exports.EXECUTABLE_KEYS = securitySettings.EXECUTABLE_KEYS;
exports.resolveCliPath = securitySettings.resolveCliPath;
exports.setMachineCliPath = securitySettings.setMachineCliPath;
exports.CliPathRejectedError = securitySettings.CliPathRejectedError;
// Issue #30: the store guard (Protected Mode off) and the turn-end check.
exports.approvalsStoreVerdict = mcpApprovals.approvalsStoreVerdict;
// R3-1: a CODEX_HOME that only marks the vault untrusted (hooks down).
exports.codexTrustOnlyOverlay = codex_cli_1.buildTrustOnlyOverlay;
exports.ensureStoreGuardScript = storeGuard.ensureStoreGuardScript;
exports.snapshotSecurityStore = securitySettings.snapshotSecurityStore;
exports.checkSecurityStoreTamper = securitySettings.checkSecurityStoreTamper;
exports.onSecurityStoreTamper = securitySettings.onSecurityStoreTamper;
// Promoted from constants — protected-pattern catalog data
exports.DEFAULT_PROTECTED_PATHS = constants.DEFAULT_PROTECTED_PATHS;
exports.DEFAULT_PROTECTED_COMMANDS = constants.DEFAULT_PROTECTED_COMMANDS;
exports.PROTECTED_CATEGORIES = constants.PROTECTED_CATEGORIES;
// System-prompt hint constants — these are pure data, frequently
// imported by name, so spread to top level alongside the namespace.
__exportStar(require("./system-prompt-hints"), exports);
function createProtectionContext({ plugin, settings, config, hostAdapter, onDecision, security, } = {}) {
    const host = plugin;
    const _settings = config || settings || (host && host.settings) || {};
    const _hostAdapter = (hostAdapter ||
        new host_adapter_1.HeadlessHostAdapter());
    // Issue #30 (G4): the security input is the snapshot, else an explicit
    // config/settings from the caller's code — never `plugin.settings` (the
    // host's data.json). With neither, securityInputsOf returns the defaults.
    // (securitySettings is CommonJS, called through its module object so test
    // stubs apply; its result is typed here.)
    const _security = securitySettings.securityInputsOf({ security, settings: config || settings || undefined, plugin });
    return {
        prepareSpawn({ kind, cwd, providerOptions = {} }) {
            // Delegate to the existing hook-dispatcher entry. Its signature
            // expects `{ kind, plugin, options }` — `cwd` rides inside options.
            const merged = { ...providerOptions, cwd, ...(security ? { security } : {}) };
            return hookDispatcher.prepareSpawn({
                kind,
                plugin: plugin,
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
            return attackDetector.classify(toolName, toolInput, { plugin, settings: _settings, security: _security, vaultRoot, hostAdapter: _hostAdapter });
        },
        isAvailable() {
            // Protection is "available" when settings allow it AND the host has
            // an IPC server we can register with. The host plugin exposes
            // `ipcServer` after onload completes.
            if (_security.protectedMode === false)
                return false;
            if (!host || !host.ipcServer)
                return false;
            try {
                return host.ipcServer.isListening && host.ipcServer.isListening();
            }
            catch (e) {
                // isListening() should not throw under any documented
                // condition. If it does, that's a setup-level bug a non-
                // Obsidian consumer would want to know about — silently
                // returning false makes "protection is disabled" look
                // intentional rather than broken.
                console.error("[gryphon/protect] ipcServer.isListening threw — protection disabled:", e && e.message);
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
         *           falls back to the security snapshot's permissionMode, then "default"
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
        async decide({ tool, args, mode, scope }) {
            const vaultRoot = scope && Array.isArray(scope.allowedRoots) && scope.allowedRoots[0]
                ? scope.allowedRoots[0]
                : null;
            const classifyResult = attackDetector.classify(tool, args, { plugin, settings: _settings, security: _security, vaultRoot, hostAdapter: _hostAdapter });
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
                    }
                    catch (e) {
                        // Sink errors are isolation failures — surface to host adapter but
                        // never block the decision. Consumers can implement their own retry
                        // by buffering inside the sink.
                        if (_hostAdapter && _hostAdapter.notify) {
                            try {
                                _hostAdapter.notify(`audit sink threw: ${e.message}`, { level: "warn" });
                            }
                            catch { /* notify must not block either */ }
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
            const effectiveMode = mode || _security.permissionMode || "default";
            const canonical = attackDetector.normalizeToolName(tool);
            const isBash = canonical === "Bash" || canonical === "PowerShell";
            const kind = isBash ? "protected-exec" : "protected";
            const action = isBash ? "run" : "write";
            const target = isBash
                ? (args && typeof args.command === "string" ? args.command : String(tool))
                : (args && (args.file_path || args.path) ? (args.file_path || args.path) : String(tool));
            const headlessCtx = {
                permissionMode: effectiveMode,
                security: _security,
                plugin, // null/undefined in fully headless callers → no-modal path
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
                    fixedInvariant: !!classifyResult && "fixedInvariant" in classifyResult && classifyResult.fixedInvariant === true,
                });
            }
            catch (gateErr) {
                const errorResult = { decision: "deny", reason: `gate-error: ${gateErr.message}` };
                if (onDecision) {
                    try {
                        onDecision({
                            ts: Date.now(),
                            tool,
                            args_summary: summariseArgs(args),
                            decision: errorResult.decision,
                            reason: errorResult.reason,
                        });
                    }
                    catch { /* sink err */ }
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
                }
                catch (e) {
                    // Sink errors are isolation failures — surface to host adapter but
                    // never block the decision. Consumers can implement their own retry
                    // by buffering inside the sink.
                    if (_hostAdapter && _hostAdapter.notify) {
                        try {
                            _hostAdapter.notify(`audit sink threw: ${e.message}`, { level: "warn" });
                        }
                        catch { /* notify must not block either */ }
                    }
                }
            }
            return result;
        },
    };
}
