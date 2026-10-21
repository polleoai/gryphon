// Public API for @polleoai/gryphon-provider-config.
//
// The configuration layer is the cc-switch-shaped piece: pure data and
// selection logic. No process spawning, no HTTP, no UI. A consumer can
// resolve "which provider, which model, which key" without ever loading
// the runtime layer — useful for CLI front-ends, settings UIs in
// non-Obsidian hosts, and the future engine/content packaging story.

import * as extraArgsFilter from "./extra-args-filter";
import * as anthropicPricing from "./pricing/anthropic";
import * as openaiPricing from "./pricing/openai";
import * as googlePricing from "./pricing/google";
import * as registry from "./registry";

// Default provider preference value — moved here from plugin/constants.js
// in v1.5.0 (per ADR 0006 + code review V5-1) so provider-runtime no
// longer reaches back into plugin source for this single constant.
const DEFAULT_PROVIDER_PREFERENCE = "auto";

// Per-provider extraArgs allow-list filter
export const filterExtraArgs = extraArgsFilter.filterExtraArgs;
export const PROVIDER_FLAGS = extraArgsFilter.PROVIDER_FLAGS;

// Pricing namespaces (cost tables + getModelDropdownOptions per vendor)
export const pricing = {
  anthropic: anthropicPricing,
  openai: openaiPricing,
  google: googlePricing,
};

export {
  extraArgsFilter,
  // Default provider-selection preference
  DEFAULT_PROVIDER_PREFERENCE,
  // Canonical registry — single source of truth for models, pricing,
  // context windows, cold-start budgets, and alias resolution.
  registry,
};
