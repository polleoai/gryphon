import * as extraArgsFilter from "./extra-args-filter";
import * as anthropicPricing from "./pricing/anthropic";
import * as openaiPricing from "./pricing/openai";
import * as googlePricing from "./pricing/google";
import * as registry from "./registry";
declare const DEFAULT_PROVIDER_PREFERENCE = "auto";
export declare const filterExtraArgs: typeof extraArgsFilter.filterExtraArgs;
export declare const PROVIDER_FLAGS: Record<string, Set<string>>;
export declare const pricing: {
    anthropic: typeof anthropicPricing;
    openai: typeof openaiPricing;
    google: typeof googlePricing;
};
export { extraArgsFilter, DEFAULT_PROVIDER_PREFERENCE, registry, };
