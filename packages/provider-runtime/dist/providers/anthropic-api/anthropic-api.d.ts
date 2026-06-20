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
export {};
