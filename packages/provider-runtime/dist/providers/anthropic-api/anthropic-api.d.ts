/**
 * AnthropicAPIProvider — implements the LLMProvider contract via the
 * official @anthropic-ai/sdk client.
 *
 * Phase 2: pure chat (no tool use). The provider maintains the message
 * history client-side (the API is stateless) and streams responses
 * through the contract's onMessage/onError/onDone callbacks. Tool support
 * lands in Phase 3 (read-only) and Phase 4 (read-write).
 *
 * Authentication: caller passes apiKey at construction. Source priority
 * (settings field → ANTHROPIC_API_KEY env) is the factory's job, not ours.
 *
 * Cost calculation: SDK reports token usage; we multiply by a per-model
 * price table to estimate per-turn cost. The price table lives in the
 * canonical registry at `packages/provider-config/src/registry.js` — update
 * that file when Anthropic's pricing changes, and run
 * `scripts/probe-model.sh anthropic <id>` for any newly-added model id.
 */
declare const resolveModel: any;
declare class AnthropicAPIProvider {
    [key: string]: any;
    constructor(apiKey: any, cwd: any, options?: Record<string, any>);
    isAlive(): boolean;
    /**
     * Build the request body for `messages.countTokens` — authoritative
     * pre-send count of input tokens for the NEXT turn if it were sent
     * with `prospectiveInput` as the user message.
     *
     * Split out from `countTokensForNext` so unit tests can verify the
     * request shape (system prompt, tool list, message order) without
     * needing an Anthropic client. The Stage A heuristic estimator is the
     * fallback when this network call isn't available — the SDK number
     * here is authoritative when present.
     *
     * The empty-prospective-input case is special-cased: the API rejects
     * an empty user message, so we pass a single space (1-token cost) just
     * to keep the request well-formed. The chat-view caller treats the
     * difference as noise.
     *
     * @param {string} prospectiveInput  — text the user has typed but not sent
     * @returns {object} — `{ model, system, tools, messages }`
     */
    _buildCountTokensRequest(prospectiveInput: any): Record<string, any>;
    /**
     * Authoritative pre-send token count for SDK mode (F1).
     *
     * Calls Anthropic's `messages.countTokens` endpoint with the same
     * arguments `send()` would use, plus a prospective user message. Cheap
     * — no generation, no streaming, one network roundtrip — but still
     * worth caching against repeated typing on the same prefix.
     *
     * Returns `null` on any failure (network, auth, rate-limit, SDK
     * version that doesn't support countTokens). The chat-view falls back
     * to the heuristic estimator on null.
     *
     * @param {string} prospectiveInput
     * @returns {Promise<number|null>}  input_tokens, or null on failure
     */
    countTokensForNext(prospectiveInput: any): Promise<any>;
    get costIsEstimate(): boolean;
    abort(): void;
    send(prompt: any, options?: Record<string, any>): Promise<Record<string, any>>;
    _extractText(content: any): string;
    _formatError(err: any): string;
}
/**
 * Validate an API key by making a trivial /messages call. Used by the
 * "Test key" button in settings. Returns { ok, message }.
 */
declare function testApiKey(apiKey: any): Promise<{
    ok: boolean;
    message: string;
}>;
export { AnthropicAPIProvider, testApiKey, resolveModel };
