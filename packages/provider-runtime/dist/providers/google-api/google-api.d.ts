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
declare const resolveModel: any, DEFAULT_MODEL: any;
declare const testApiKey: typeof import("./test-key").testApiKey;
declare class GoogleProvider {
    [key: string]: any;
    constructor(apiKey: any, cwd: any, options?: Record<string, any>);
    isAlive(): boolean;
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
    send(prompt: any, options?: Record<string, any>): Promise<Record<string, any>>;
    _formatError(err: any): string;
}
export { GoogleProvider, testApiKey, resolveModel, DEFAULT_MODEL };
