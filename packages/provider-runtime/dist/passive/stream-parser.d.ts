import type { ContentBlock, PassiveUsage, StopReason } from "./types";
interface RawUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
/** A finalized turn, returned by `push` on a `result` event. */
interface PassiveTurnResult {
    content: ContentBlock[];
    stop_reason: StopReason;
    usage: PassiveUsage;
    total_cost_usd: number;
    sessionId: string;
    _resultError?: string | null;
}
declare class PassiveStreamParser {
    sessionId: string | null;
    resolvedModel: string | null;
    _content: ContentBlock[];
    _lastUsage: RawUsage | null;
    constructor();
    push(rawEvent: unknown): PassiveTurnResult | null;
    reset(): void;
}
export { PassiveStreamParser };
export type { PassiveTurnResult };
