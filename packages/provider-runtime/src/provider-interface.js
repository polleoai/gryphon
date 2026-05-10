/**
 * LLMProvider contract — every chat backend implements this shape.
 *
 * This file is documentation-only (JavaScript is duck-typed). Concrete
 * providers live under `providers/claude-code/` (subprocess) and `providers/anthropic-api/`
 * (direct HTTP via @anthropic-ai/sdk).
 *
 * Lifecycle:
 *   1. Caller (chat-view) constructs a provider via `factory.createProvider(...)`
 *   2. Caller assigns `onMessage`, `onError`, `onDone` callbacks
 *   3. Caller invokes `send(prompt)` per user turn
 *   4. Provider streams via callbacks during the turn
 *   5. `send` resolves with the final result when the turn completes
 *   6. Caller may call `abort()` to cancel an in-flight turn
 *
 * Callback signatures:
 *   onMessage(text, type)
 *     type === "init"     — provider/session ready; text is empty
 *     type === "replace"  — replace streaming bubble content with `text`
 *     type === "tool"     — tool invocation; `text` is the tool name
 *
 *   onError(text)
 *     stderr / API error string for diagnostics
 *
 *   onDone(result)
 *     turn complete; result = {
 *       text:           string,  // final assistant text
 *       cost:           number,  // USD for this turn
 *       cumulativeCost: number,  // USD across the session
 *       sessionId:      string,  // for resume
 *       duration:       number,  // ms
 *       contextTokens:  number,  // last-known input-token occupancy
 *     }
 *
 * Required methods:
 *   send(prompt: string): Promise<Result>
 *   abort(): void                 — cancel in-flight turn
 *   isAlive(): boolean            — is a request currently active or pending?
 *
 * Required properties (read by chat-view for UI):
 *   sessionId:      string|null   — current session identifier (for resume)
 *   resolvedModel:  string|null   — concrete model ID (e.g. "claude-opus-4-7")
 *   contextTokens:  number        — last-known context-window occupancy
 *
 * Providers MUST be safe to construct without immediately spawning anything;
 * the first `send()` call is allowed to perform lazy initialization.
 */

module.exports = {};
