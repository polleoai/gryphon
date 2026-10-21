"use strict";
// Public API for @polleoai/gryphon-provider-runtime.
//
// The runtime layer owns the LLM provider abstraction: spawn / stream /
// abort / retry. Six provider implementations live under ./providers/.
// Consumers should import via the named exports here rather than reaching
// for individual files; deep imports (`@polleoai/gryphon-provider-runtime/src/...`)
// continue to work for now but the public API is the stable surface.
//
// Note: this layer is **substitutable** in the open-core sense — the
// `protectionContext` parameter accepted by createProvider is opaque
// (anything implementing { prepareSpawn, classify, isAvailable }). A
// non-Obsidian consumer can pass `null` for unprotected mode or supply
// their own context.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliStructuredOutputError = exports.BudgetExceededError = exports.subprocessRegistry = exports.utils = exports.factory = exports.createPassiveSession = exports.liveSubprocessCount = exports.killAllSubprocesses = exports.pricing = exports.displayPath = exports.clearBinaryDiscoveryCache = exports.detectFlatpakSandbox = exports.buildEnhancedPath = exports.findNodeBinary = exports.findAntigravityBinary = exports.findGeminiBinary = exports.findCodexBinary = exports.findClaudeBinary = exports.friendlyProviderLabel = exports.humanizeFailureReason = exports.describeProviderReadiness = exports.defaultModelForKind = exports.createProviderForKind = exports.resolveFallback = exports.classifyProviderFailure = exports.getActiveProviderKind = exports.detectAvailable = exports.explainUnavailable = exports.createProvider = void 0;
const factory = __importStar(require("./factory"));
exports.factory = factory;
const failover = __importStar(require("./failover"));
const readiness = __importStar(require("./readiness"));
const utils = __importStar(require("./utils"));
exports.utils = utils;
const subprocessRegistry = __importStar(require("./subprocess-registry"));
exports.subprocessRegistry = subprocessRegistry;
const passive = __importStar(require("./passive"));
const budget_error_1 = require("./budget-error");
Object.defineProperty(exports, "BudgetExceededError", { enumerable: true, get: function () { return budget_error_1.BudgetExceededError; } });
const cli_structured_output_1 = require("./cli-structured-output");
Object.defineProperty(exports, "CliStructuredOutputError", { enumerable: true, get: function () { return cli_structured_output_1.CliStructuredOutputError; } });
// Pricing tables live in @polleoai/gryphon-provider-config (centralized in v2.2's
// registry refactor). Re-exported here for back-compat with callers that
// import via `@polleoai/gryphon-provider-runtime`.pricing.
const gryphon_provider_config_1 = require("@polleoai/gryphon-provider-config");
const openaiPricing = gryphon_provider_config_1.pricing.openai;
const googlePricing = gryphon_provider_config_1.pricing.google;
// Factory — consumer's primary entry point
exports.createProvider = factory.createProvider;
exports.explainUnavailable = factory.explainUnavailable;
exports.detectAvailable = factory.detectAvailable;
exports.getActiveProviderKind = factory.getActiveProviderKind;
// Failover kernel (issue #15) — the reusable, host-agnostic decision layer.
// classifyProviderFailure + resolveFallback + createProviderForKind let any
// consumer (the chat-view orchestrator, or an embedding plugin's own path) build a
// one-hop availability failover without reaching into the chat view.
exports.classifyProviderFailure = failover.classifyProviderFailure;
exports.resolveFallback = factory.resolveFallback;
exports.createProviderForKind = factory.createProviderForKind;
// Per-kind default model (CLI kinds with a model subset have their own) —
// the Settings fallback picker pre-selects it.
exports.defaultModelForKind = factory.defaultModelForKind;
// Readiness kernel (issue #16) — the proactive, before-send companion to
// the #15 failover signal. describeProviderReadiness answers "is the
// selected provider usable, and if not why" from presence alone (no
// network); the two humanizers give both UI surfaces one shared vocabulary.
exports.describeProviderReadiness = readiness.describeProviderReadiness;
exports.humanizeFailureReason = readiness.humanizeFailureReason;
exports.friendlyProviderLabel = readiness.friendlyProviderLabel;
// Binary discovery + path helpers (formerly plugin/src/utils.js)
exports.findClaudeBinary = utils.findClaudeBinary;
exports.findCodexBinary = utils.findCodexBinary;
exports.findGeminiBinary = utils.findGeminiBinary;
exports.findAntigravityBinary = utils.findAntigravityBinary;
exports.findNodeBinary = utils.findNodeBinary;
exports.buildEnhancedPath = utils.buildEnhancedPath;
exports.detectFlatpakSandbox = utils.detectFlatpakSandbox;
exports.clearBinaryDiscoveryCache = utils.clearBinaryDiscoveryCache;
exports.displayPath = utils.displayPath;
// Pricing namespaces — re-exported from @polleoai/gryphon-provider-config for back-compat.
// All three vendors are available; anthropic is listed first alphabetically.
// Typed as provider-config's own export so the emitted .d.ts names the
// package root, not a deep dist/ path its exports map doesn't publish.
exports.pricing = {
    anthropic: gryphon_provider_config_1.pricing.anthropic,
    openai: openaiPricing,
    google: googlePricing,
};
// Subprocess lifecycle — the host (Obsidian onunload, or any embedder's
// shutdown path) calls killAllSubprocesses() to reap every CLI child tree
// the runtime spawned. See subprocess-registry.ts for the full contract.
exports.killAllSubprocesses = subprocessRegistry.killAll;
exports.liveSubprocessCount = subprocessRegistry.liveCount;
// Passive-backend mode — claude as a structured LLM backend (Anthropic
// Messages-API content blocks) for callers that own tool execution.
// See src/passive/README.md.
exports.createPassiveSession = passive.createPassiveSession;
