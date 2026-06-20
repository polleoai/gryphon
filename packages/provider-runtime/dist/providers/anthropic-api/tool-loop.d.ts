/**
 * Tool-use loop driver — coordinates multi-turn agentic interactions
 * with the Anthropic API in Anthropic API mode.
 *
 * The pattern:
 *   1. Send messages (with tool definitions) → SDK streams text deltas
 *   2. If finalMessage.stop_reason === "tool_use", extract tool_use blocks
 *   3. Execute each tool locally → build tool_result blocks
 *   4. Append assistant turn + user turn (with tool_results) to history
 *   5. Loop until stop_reason !== "tool_use"
 *
 * Per-iteration callbacks let the chat-view stream text deltas, surface
 * tool invocations in the status bar, and aggregate cost across turns.
 *
 * Safety rails:
 *   - MAX_ITERATIONS prevents an infinite tool loop (model gone wild)
 *   - Tool errors return as is_error=true content; the model can recover
 *   - The activeStream reference is passed through so abort() works at
 *     any iteration boundary
 */
export {};
