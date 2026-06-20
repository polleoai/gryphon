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
export {};
