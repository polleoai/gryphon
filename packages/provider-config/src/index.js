// Public API for @gryphon/provider-config.
//
// The configuration layer is the cc-switch-shaped piece: pure data and
// selection logic. No process spawning, no HTTP, no UI. A consumer can
// resolve "which provider, which model, which key" without ever loading
// the runtime layer — useful for CLI front-ends, settings UIs in
// non-Obsidian hosts, and the future engine/content packaging story.

const extraArgsFilter = require("./extra-args-filter");
const openaiPricing = require("./pricing/openai");
const googlePricing = require("./pricing/google");

// Default provider preference value — moved here from plugin/constants.js
// in v1.5.0 (per ADR 0006 + code review V5-1) so provider-runtime no
// longer reaches back into plugin source for this single constant.
const DEFAULT_PROVIDER_PREFERENCE = "auto";

module.exports = {
  // Per-provider extraArgs allow-list filter
  filterExtraArgs: extraArgsFilter.filterExtraArgs,
  PROVIDER_FLAGS: extraArgsFilter.PROVIDER_FLAGS,
  extraArgsFilter,

  // Default provider-selection preference
  DEFAULT_PROVIDER_PREFERENCE,

  // Pricing namespaces (cost tables + getModelDropdownOptions per vendor)
  pricing: {
    openai: openaiPricing,
    google: googlePricing,
  },
};
