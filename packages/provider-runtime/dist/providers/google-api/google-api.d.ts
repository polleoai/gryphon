/**
 * GoogleProvider — implements the LLMProvider contract via the official
 * `@google/genai` npm SDK (Gemini API).
 *
 * Stage 3 — second hand-built non-Anthropic adapter. Mirrors the structure
 * of OpenAIProvider deliberately so the chat-view doesn't need provider-
 * specific branches.
 *
 * The Gemini API is stateless (chat history must be replayed each turn).
 * Streaming uses `client.models.generateContentStream(...)` which returns
 * an async generator of GenerateContentResponse chunks; the provider
 * forwards accumulated text snapshots through onMessage(text, "replace").
 *
 * Tool support lives in `tool-loop.js`. The provider's `send` delegates
 * to `runGeminiToolLoop`, which speaks Gemini's functionCall/functionResponse
 * shape but reuses Gryphon's existing tool registry — security parity.
 *
 * Cost calculation: SDK reports promptTokenCount / candidatesTokenCount /
 * cachedContentTokenCount; pricing.js computeCost() converts to USD.
 */
import type { Content, GoogleGenAI as GoogleGenAIClient } from "@google/genai";
import { testApiKey } from "./test-key";
declare const resolveModel: typeof import("@polleoai/gryphon-provider-config/dist/pricing/google").resolveModel, DEFAULT_MODEL: string;
interface GeminiAbortableStream {
    return?: (value?: unknown) => unknown;
}
interface GoogleProviderOptions {
    hostAdapter?: unknown;
    client?: GoogleGenAIClient;
    initialHistory?: IncomingHistoryEntry[];
    model?: string | null;
    permissionMode?: string;
    plugin?: unknown;
    security?: unknown;
    [key: string]: unknown;
}
interface GoogleSendOptions {
    maxUsdBudget?: number | null;
    structuredOutput?: {
        name: string;
        schema: Record<string, unknown>;
    } | null;
    [key: string]: unknown;
}
interface GoogleTurnResult {
    text: string;
    cost: number;
    cumulativeCost: number;
    sessionId: string;
    duration: number;
    contextTokens: number;
    json?: unknown;
}
type IncomingHistoryEntry = {
    role?: unknown;
    parts?: unknown;
    content?: unknown;
    text?: unknown;
} | null | undefined;
declare class GoogleProvider {
    apiKey: string;
    cwd: string;
    options: GoogleProviderOptions;
    hostAdapter: unknown;
    client: GoogleGenAIClient | null;
    history: Content[];
    sessionId: string;
    resolvedModel: string;
    contextTokens: number;
    cumulativeCost: number;
    startTime: number;
    activeStream: GeminiAbortableStream | null;
    pending: boolean;
    destroyed: boolean;
    onMessage: ((text: string, type: string) => void) | null;
    onError: ((text: string) => void) | null;
    onDone: ((result: GoogleTurnResult) => void) | null;
    _needsHistoryReset: boolean | undefined;
    constructor(apiKey: string, cwd: string, options?: GoogleProviderOptions);
    isAlive(): boolean;
    /**
     * The SDK client, built on first use. Loads the SDK (once per process)
     * unless a client was injected or already built.
     */
    _ensureClient(): Promise<GoogleGenAIClient>;
    get costIsEstimate(): boolean;
    abort(): void;
    /**
     * **Concurrency invariant** (BT-6 Round 18, BT-3 Round 20): callers MUST
     * serialize `send()` invocations against the SAME provider instance.
     * The chat-view does this via the `isStreaming` enqueue gate
     * (chat-view.js:3653). Without that gate, a second `send()` while the
     * first is awaiting would clobber `pending`, `activeStream`, and
     * `historyCheckpoint` — the second send's user message could be truncated
     * by the first send's error rollback. Inherited from openai-api / anthropic-api.
     */
    send(prompt: string, options?: GoogleSendOptions): Promise<GoogleTurnResult>;
    _formatError(err: unknown): string;
}
export { GoogleProvider, testApiKey, resolveModel, DEFAULT_MODEL };
