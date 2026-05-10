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
const utils = require("./utils");

// Pricing tables — currently live under their respective provider dirs
// because they were colocated with the provider implementation. Stage 4
// (provider-config extraction) re-routes these to the config layer; for
// now they ride along with runtime.
const openaiPricing = require("@gryphon/provider-config").pricing.openai;
const googlePricing = require("@gryphon/provider-config").pricing.google;

module.exports = {
  // Factory — consumer's primary entry point
  createProvider: factory.createProvider,
  explainUnavailable: factory.explainUnavailable,
  detectAvailable: factory.detectAvailable,
  getActiveProviderKind: factory.getActiveProviderKind,
  factory,

  // Binary discovery + path helpers (formerly plugin/src/utils.js)
  findClaudeBinary: utils.findClaudeBinary,
  findCodexBinary: utils.findCodexBinary,
  findGeminiBinary: utils.findGeminiBinary,
  findNodeBinary: utils.findNodeBinary,
  buildEnhancedPath: utils.buildEnhancedPath,
  detectFlatpakSandbox: utils.detectFlatpakSandbox,
  clearBinaryDiscoveryCache: utils.clearBinaryDiscoveryCache,
  displayPath: utils.displayPath,
  utils,

  // Pricing namespaces (Stage 4 will move these to provider-config)
  pricing: {
    openai: openaiPricing,
    google: googlePricing,
  },
};
