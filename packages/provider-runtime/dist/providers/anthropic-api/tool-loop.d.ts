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
declare const MAX_ITERATIONS = 25;
declare const GRYPHON_SDK_SYSTEM_PROMPT: string;
/**
 * @param {object} args
 *   client       — Anthropic SDK client
 *   model        — resolved model ID
 *   history      — message array (modified in place; caller owns lifecycle)
 *   ctx          — execution context { vaultRoot, permissionMode, plugin }
 *   callbacks    — { onMessage(text, type), onTool(name), onError(text), onStream(stream) }
 *
 * @returns {Promise<{turnText, finalMessage, totalUsage, iterations}>}
 *   totalUsage aggregates token counts across all loop iterations.
 *
 * CONTRACT — shared-history invariant:
 *   `history` is mutated IN PLACE (push) by this loop. The caller
 *   (anthropic-api.js `send`) captures `historyCheckpoint = history.length`
 *   BEFORE calling runToolLoop so it can roll back on error via
 *   `history.length = historyCheckpoint`. That rollback depends on this
 *   array being the SAME reference the caller holds — if a future
 *   refactor passes a copy here or clones internally, the caller's
 *   history will keep partial turn content after a thrown error.
 *   If you need to decouple: take a `pushTurn(turn)` callback argument
 *   from the caller and let the caller own all history mutations.
 */
declare function runToolLoop({ client, model, history, ctx, callbacks }: {
    client: any;
    model: any;
    history: any;
    ctx: any;
    callbacks: any;
}): Promise<{
    turnText: string;
    finalMessage: any;
    totalUsage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    };
    peakUsage: {
        input_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    };
    iterations: number;
    thinkingBlocks: any[];
}>;
export { runToolLoop, MAX_ITERATIONS, GRYPHON_SDK_SYSTEM_PROMPT };
