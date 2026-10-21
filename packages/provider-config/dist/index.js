"use strict";
// Public API for @polleoai/gryphon-provider-config.
//
// The configuration layer is the cc-switch-shaped piece: pure data and
// selection logic. No process spawning, no HTTP, no UI. A consumer can
// resolve "which provider, which model, which key" without ever loading
// the runtime layer — useful for CLI front-ends, settings UIs in
// non-Obsidian hosts, and the future engine/content packaging story.
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
exports.registry = exports.DEFAULT_PROVIDER_PREFERENCE = exports.extraArgsFilter = exports.pricing = exports.PROVIDER_FLAGS = exports.filterExtraArgs = void 0;
const extraArgsFilter = __importStar(require("./extra-args-filter"));
exports.extraArgsFilter = extraArgsFilter;
const anthropicPricing = __importStar(require("./pricing/anthropic"));
const openaiPricing = __importStar(require("./pricing/openai"));
const googlePricing = __importStar(require("./pricing/google"));
const registry = __importStar(require("./registry"));
exports.registry = registry;
// Default provider preference value — moved here from plugin/constants.js
// in v1.5.0 (per ADR 0006 + code review V5-1) so provider-runtime no
// longer reaches back into plugin source for this single constant.
const DEFAULT_PROVIDER_PREFERENCE = "auto";
exports.DEFAULT_PROVIDER_PREFERENCE = DEFAULT_PROVIDER_PREFERENCE;
// Per-provider extraArgs allow-list filter
exports.filterExtraArgs = extraArgsFilter.filterExtraArgs;
exports.PROVIDER_FLAGS = extraArgsFilter.PROVIDER_FLAGS;
// Pricing namespaces (cost tables + getModelDropdownOptions per vendor)
exports.pricing = {
    anthropic: anthropicPricing,
    openai: openaiPricing,
    google: googlePricing,
};
