// Public API for @gryphon/provider-runtime.
//
// The runtime layer owns the LLM provider abstraction: spawn / stream /
// abort / retry. Six provider implementations live under ./providers/.
// Consumers should import via the named exports here rather than reaching
// for individual files; deep imports (`@gryphon/provider-runtime/src/...`)
// continue to work for now but the public API is the stable surface.
//
// Note: this layer is **substitutable** in the open-core sense — the
// `protectionContext` parameter accepted by createProvider is opaque
// (anything implementing { prepareSpawn, classify, isAvailable }). A
// non-Obsidian consumer can pass `null` for unprotected mode or supply
// their own context.

const factory = require("./factory");
const failover = require("./failover");
const readiness = require("./readiness");
const utils = require("./utils");
const subprocessRegistry = require("./subprocess-registry");
const passive = require("./passive");
const { BudgetExceededError } = require("./budget-error");
const { CliStructuredOutputError } = require("./cli-structured-output");

// Pricing tables live in @gryphon/provider-config (centralized in v2.2's
// registry refactor). Re-exported here for back-compat with callers that
// import via `@gryphon/provider-runtime`.pricing.
const openaiPricing = require("@gryphon/provider-config").pricing.openai;
const googlePricing = require("@gryphon/provider-config").pricing.google;

module.exports = {
  // Factory — consumer's primary entry point
  createProvider: factory.createProvider,
  explainUnavailable: factory.explainUnavailable,
  detectAvailable: factory.detectAvailable,
  getActiveProviderKind: factory.getActiveProviderKind,
  factory,

  // Failover kernel (issue #15) — the reusable, host-agnostic decision layer.
  // classifyProviderFailure + resolveFallback + createProviderForKind let any
  // consumer (the chat-view orchestrator, or Athena's synthesis path) build a
  // one-hop availability failover without reaching into the chat view.
  classifyProviderFailure: failover.classifyProviderFailure,
  resolveFallback: factory.resolveFallback,
  createProviderForKind: factory.createProviderForKind,

  // Readiness kernel (issue #16) — the proactive, before-send companion to
  // the #15 failover signal. describeProviderReadiness answers "is the
  // selected provider usable, and if not why" from presence alone (no
  // network); the two humanizers give both UI surfaces one shared vocabulary.
  describeProviderReadiness: readiness.describeProviderReadiness,
  humanizeFailureReason: readiness.humanizeFailureReason,
  friendlyProviderLabel: readiness.friendlyProviderLabel,

  // Binary discovery + path helpers (formerly plugin/src/utils.js)
  findClaudeBinary: utils.findClaudeBinary,
  findCodexBinary: utils.findCodexBinary,
  findGeminiBinary: utils.findGeminiBinary,
  findAntigravityBinary: utils.findAntigravityBinary,
  findNodeBinary: utils.findNodeBinary,
  buildEnhancedPath: utils.buildEnhancedPath,
  detectFlatpakSandbox: utils.detectFlatpakSandbox,
  clearBinaryDiscoveryCache: utils.clearBinaryDiscoveryCache,
  displayPath: utils.displayPath,
  utils,

  // Pricing namespaces — re-exported from @gryphon/provider-config for back-compat.
  // All three vendors are available; anthropic is listed first alphabetically.
  pricing: {
    anthropic: require("@gryphon/provider-config").pricing.anthropic,
    openai: openaiPricing,
    google: googlePricing,
  },

  // Subprocess lifecycle — the host (Obsidian onunload, or any embedder's
  // shutdown path) calls killAllSubprocesses() to reap every CLI child tree
  // the runtime spawned. See subprocess-registry.ts for the full contract.
  killAllSubprocesses: subprocessRegistry.killAll,
  liveSubprocessCount: subprocessRegistry.liveCount,
  subprocessRegistry,

  // Passive-backend mode — claude as a structured LLM backend (Anthropic
  // Messages-API content blocks) for callers that own tool execution.
  // See src/passive/README.md.
  createPassiveSession: passive.createPassiveSession,

  // Error classes — consumers can instanceof-check against these.
  BudgetExceededError,
  CliStructuredOutputError,
};
