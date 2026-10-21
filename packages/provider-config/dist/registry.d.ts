/**
 * Canonical model registry for Gryphon.
 *
 * Single source of truth for: pricing, aliases, context windows, cold-start
 * budgets, dropdown labels, vendor-specific subsets (e.g. Codex CLI's
 * ChatGPT-auth whitelist), and the legacy-alias migration table.
 *
 * The per-vendor pricing files (`pricing/openai.js`, `pricing/google.js`,
 * `pricing/anthropic.js`) and the plugin-shell tables (`MODELS`,
 * `MODEL_CONTEXT`, `COLD_START_BUDGET_MS`, `MODEL_ALIAS_MIGRATION`) all
 * derive from this registry. Adding a new model = editing this file only.
 *
 * **Probe discipline**: no model lands here without a successful probe
 * via `scripts/probe-model.sh <vendor> <id>`. The commit message must
 * include the probe verdict.
 */
declare const MODELS: ({
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault: boolean;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    contextTokens: number;
    coldStartMs: number;
    dropdown?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    codexCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    codexCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    antigravityCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
})[];
declare const VENDOR_FALLBACK_PRICING: Record<string, Record<string, number>>;
declare const CROSS_VENDOR_ALIASES: Record<string, Record<string, string>>;
declare const LEGACY_ALIAS_MIGRATION: Record<string, Record<string, string>>;
declare const RETIRED_MODEL_MIGRATION: Record<string, string>;
declare function allModels(): ({
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault: boolean;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    contextTokens: number;
    coldStartMs: number;
    dropdown?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    codexCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    codexCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    antigravityCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
})[];
declare function modelsByVendor(vendor: string): ({
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens: number;
    coldStartMs: number;
    isDefault: boolean;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input?: undefined;
    };
    contextTokens: number;
    coldStartMs: number;
    dropdown?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    codexCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    codexCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
    antigravityCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    dropdown: {
        label: string;
        desc: string;
    };
    isDefault: boolean;
    antigravityCliSupported: boolean;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    codexCliSupported?: undefined;
} | {
    id: string;
    vendor: string;
    pricing: {
        input: number;
        output: number;
        cached_input: number;
    };
    antigravityCliSupported: boolean;
    dropdown?: undefined;
    contextTokens?: undefined;
    coldStartMs?: undefined;
    isDefault?: undefined;
    codexCliSupported?: undefined;
})[];
declare function priceFor(modelId: string, vendor: string): {
    input: number;
    output: number;
    cached_input?: undefined;
} | {
    input: number;
    output: number;
    cached_input: number;
} | Record<string, number>;
/**
 * Resolve an alias or concrete model id to a vendor-specific concrete id.
 *
 * Three resolution paths in priority order:
 *   1. Cross-vendor alias (haiku/sonnet/opus/opus[1m]) → vendor-specific id.
 *   2. Identity passthrough — input is already a concrete id for the vendor.
 *   3. Unknown → returns null (caller decides whether to fall back).
 *
 * @returns {string|null} concrete model id, or null if unresolvable.
 */
declare function aliasFor(alias: string, vendor: string): string | null;
declare function defaultModelFor(vendor: string): string | null;
declare function dropdownFor(vendor: string): {
    id: string;
    label: string;
    desc: string;
}[];
declare function isKnownModel(modelId: string): boolean;
declare function contextTokensFor(modelId: string): number | null;
declare function coldStartMsFor(modelId: string): number | null;
declare function legacyAliasMigrationFor(vendor: string): Record<string, string>;
/**
 * Successor for a retired model id, or null when the id is current or
 * unknown. Unknown ids are deliberately left alone: forward-compat for
 * brand-new vendor ids depends on unrecognised names passing through.
 */
declare function retiredModelSuccessor(modelId: string): string | null;
declare function antigravityCliSupportedModels(): Set<string>;
declare function codexCliSupportedModels(): Set<string>;
export { MODELS, VENDOR_FALLBACK_PRICING, CROSS_VENDOR_ALIASES, LEGACY_ALIAS_MIGRATION, RETIRED_MODEL_MIGRATION, allModels, modelsByVendor, priceFor, aliasFor, defaultModelFor, dropdownFor, isKnownModel, contextTokensFor, coldStartMsFor, legacyAliasMigrationFor, retiredModelSuccessor, codexCliSupportedModels, antigravityCliSupportedModels, };
