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

import * as factory from "./factory";
import * as failover from "./failover";
import * as readiness from "./readiness";
import * as utils from "./utils";
import * as subprocessRegistry from "./subprocess-registry";
import * as passive from "./passive";
import { BudgetExceededError } from "./budget-error";
import { CliStructuredOutputError } from "./cli-structured-output";

// Pricing tables live in @polleoai/gryphon-provider-config (centralized in v2.2's
// registry refactor). Re-exported here for back-compat with callers that
// import via `@polleoai/gryphon-provider-runtime`.pricing.
import { pricing as configPricing } from "@polleoai/gryphon-provider-config";
const openaiPricing = configPricing.openai;
const googlePricing = configPricing.google;


// Factory — consumer's primary entry point
export const createProvider = factory.createProvider;
export const explainUnavailable = factory.explainUnavailable;
export const detectAvailable = factory.detectAvailable;
export const getActiveProviderKind = factory.getActiveProviderKind;

// Failover kernel (issue #15) — the reusable, host-agnostic decision layer.
// classifyProviderFailure + resolveFallback + createProviderForKind let any
// consumer (the chat-view orchestrator, or an embedding plugin's own path) build a
// one-hop availability failover without reaching into the chat view.
export const classifyProviderFailure = failover.classifyProviderFailure;
export const resolveFallback = factory.resolveFallback;
export const createProviderForKind = factory.createProviderForKind;
// Per-kind default model (CLI kinds with a model subset have their own) —
// the Settings fallback picker pre-selects it.
export const defaultModelForKind = factory.defaultModelForKind;

// Readiness kernel (issue #16) — the proactive, before-send companion to
// the #15 failover signal. describeProviderReadiness answers "is the
// selected provider usable, and if not why" from presence alone (no
// network); the two humanizers give both UI surfaces one shared vocabulary.
export const describeProviderReadiness = readiness.describeProviderReadiness;
export const humanizeFailureReason = readiness.humanizeFailureReason;
export const friendlyProviderLabel = readiness.friendlyProviderLabel;

// Binary discovery + path helpers (formerly plugin/src/utils.js)
export const findClaudeBinary = utils.findClaudeBinary;
export const findCodexBinary = utils.findCodexBinary;
export const findGeminiBinary = utils.findGeminiBinary;
export const findAntigravityBinary = utils.findAntigravityBinary;
export const findNodeBinary = utils.findNodeBinary;
export const buildEnhancedPath = utils.buildEnhancedPath;
export const detectFlatpakSandbox = utils.detectFlatpakSandbox;
export const clearBinaryDiscoveryCache = utils.clearBinaryDiscoveryCache;
export const displayPath = utils.displayPath;

// Pricing namespaces — re-exported from @polleoai/gryphon-provider-config for back-compat.
// All three vendors are available; anthropic is listed first alphabetically.
// Typed as provider-config's own export so the emitted .d.ts names the
// package root, not a deep dist/ path its exports map doesn't publish.
export const pricing: typeof configPricing = {
  anthropic: configPricing.anthropic,
  openai: openaiPricing,
  google: googlePricing,
};

// Subprocess lifecycle — the host (Obsidian onunload, or any embedder's
// shutdown path) calls killAllSubprocesses() to reap every CLI child tree
// the runtime spawned. See subprocess-registry.ts for the full contract.
export const killAllSubprocesses = subprocessRegistry.killAll;
export const liveSubprocessCount = subprocessRegistry.liveCount;

// Passive-backend mode — claude as a structured LLM backend (Anthropic
// Messages-API content blocks) for callers that own tool execution.
// See src/passive/README.md.
export const createPassiveSession = passive.createPassiveSession;

// Error classes — consumers can instanceof-check against these.

// Namespaces and error classes, exported whole.
export {
  factory,
  utils,
  subprocessRegistry,
  BudgetExceededError,
  CliStructuredOutputError,
};
