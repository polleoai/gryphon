/**
 * OpenAIProvider — implements the LLMProvider contract via the official
 * `openai` npm SDK.
 *
 * Stage 2 — first hand-built non-Anthropic adapter. Mirrors the structure
 * of AnthropicAPIProvider deliberately so the chat-view doesn't need
 * provider-specific branches (it already routes by sessionId/resolvedModel).
 *
 * The OpenAI Chat Completions API is stateless, so this provider keeps the
 * full message history client-side and replays it on every turn. Streaming
 * uses `client.chat.completions.stream(...)` which emits `content` deltas
 * with cumulative snapshots — the provider forwards each snapshot through
 * onMessage(text, "replace").
 *
 * Tool support lives in `tool-loop.js` (Stage 2d). The provider's `send`
 * delegates to `runOpenAIToolLoop`, which speaks OpenAI's tool-call shape
 * but re-uses Gryphon's existing tool registry (the registry returns
 * Anthropic-format SCHEMAs; `tool-schema-translator.js` adapts them at the
 * adapter boundary). Tool execution itself goes through the shared
 * `executeTool(...)` from anthropic-api/tools/tool-registry — that path
 * already enforces the protected-pattern guardrails (attack-detector +
 * permission-gate), so the security posture is identical regardless of
 * which provider drives the loop.
 *
 * Cost calculation: SDK reports prompt_tokens / completion_tokens /
 * prompt_tokens_details.cached_tokens; pricing.js computeCost() converts
 * to USD. Cached tokens are billed at full input rate per the v1.2 design
 * decision (track-but-don't-discount until OpenAI's pricing stabilizes).
 */
declare const resolveModel: any, DEFAULT_MODEL: any;
declare class OpenAIProvider {
    [key: string]: any;
    constructor(apiKey: any, cwd: any, options?: Record<string, any>);
    isAlive(): boolean;
    get costIsEstimate(): boolean;
    abort(): void;
    /**
     * **Concurrency invariant** (BT-6 Round 18): callers MUST serialize
     * `send()` invocations against the SAME provider instance. The chat-view
     * does this via the `isStreaming` enqueue gate (chat-view.js:3653 —
     * pending prompts queue while a turn is in flight). Without that gate,
     * a second `send()` while the first is awaiting would clobber `pending`,
     * `activeStream`, and most catastrophically `historyCheckpoint` — the
     * second send's user message could be truncated by the first send's
     * error rollback. This pattern is inherited from anthropic-api; the
     * fix path (if needed) is to convert the in-flight tracking to a queue
     * so the `pending` reset only fires for the matching turn.
     */
    send(prompt: any, options?: Record<string, any>): Promise<Record<string, any>>;
    _formatError(err: any): string;
}
/**
 * Validate an API key by making a trivial chat.completions call.
 * Used by the "Test key" button in settings.
 */
declare function testApiKey(apiKey: any): Promise<{
    ok: boolean;
    message: string;
}>;
export { OpenAIProvider, testApiKey, resolveModel, DEFAULT_MODEL };
