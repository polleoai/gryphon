export type ProviderKind = "anthropic-api" | "openai-api" | "google-api" | "claude-code" | "codex-cli" | "gemini-cli";
export type StreamMessageType = "init" | "replace" | "tool";
export interface StructuredOutputRequest {
    name: string;
    schema: object;
    maxRetries?: number;
}
export interface SendOptions {
    structuredOutput?: StructuredOutputRequest;
    maxUsdBudget?: number;
    signal?: AbortSignal;
}
export interface Result {
    text: string;
    cost: number;
    cumulativeCost: number;
    sessionId: string | null;
    duration: number;
    contextTokens: number;
    thinking?: unknown;
    json?: unknown;
}
export interface LLMProvider {
    send(prompt: string, options?: SendOptions): Promise<Result>;
    abort(): void;
    isAlive(): boolean;
    onMessage?: (text: string, type: StreamMessageType) => void;
    onError?: (text: string) => void;
    onDone?: (result: Result) => void;
    readonly sessionId: string | null;
    readonly resolvedModel: string | null;
    readonly contextTokens: number;
}
