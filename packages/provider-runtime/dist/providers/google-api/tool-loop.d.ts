/**
 * Gemini tool-use loop driver.
 *
 * Mirror of openai-api/tool-loop.js but speaks Gemini's part shape:
 *
 *   1. Send `contents: Content[]` (with `tools` config) → SDK streams
 *      GenerateContentResponse chunks; each chunk's candidates[0].content.parts
 *      may be { text } deltas or { functionCall } parts.
 *   2. Aggregate text deltas into the streaming bubble (replace mode).
 *   3. After the stream completes, inspect the final candidate:
 *      - finishReason="STOP" with no functionCalls → done.
 *      - functionCalls present → execute each via Gryphon's executeTool
 *        and append a "user"-role Content with functionResponse parts.
 *   4. Loop until no more tool calls.
 *
 * Tool execution goes through the shared `executeTool()` registry —
 * attack-detector + permission-gate fire identically across providers.
 *
 * History invariant (mirror of OpenAI loop): `history` is mutated IN PLACE
 * so the caller's send() can roll back to a pre-turn checkpoint on thrown
 * error. Do not clone the array internally.
 */
declare const MAX_ITERATIONS = 25;
declare function runGeminiToolLoop({ client, model, systemPrompt, history, ctx, callbacks, }: {
    client: any;
    model: any;
    systemPrompt: any;
    history: any;
    ctx: any;
    callbacks: any;
}): Promise<{
    turnText: string;
    finalMessage: {
        role: string;
        parts: any[];
    } | null;
    totalUsage: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        cachedContentTokenCount: number;
    };
    peakUsage: {
        promptTokenCount: number;
    };
    iterations: number;
}>;
/**
 * Convert Gryphon's executeTool result (Anthropic-shape: `{ content: [...], isError }`)
 * into the `response` object Gemini's functionResponse expects. Gemini's
 * shape is a free-form `Record<string, unknown>` — we use a stable
 * `{ result, success }` envelope so the model sees the same semantic
 * distinction it sees from anthropic-api / openai-api.
 *
 * Field naming matters here. Earlier shape was `{ error: <body> }` for
 * failures, but Gemini's model treated the literal field name `error`
 * as a tag and prepended "Error: " to the content when echoing it
 * back ("Error: This operation matches one of your protected
 * patterns..."). Other providers don't have this hazard because their
 * tool_result envelope flags `is_error` separately from the content.
 * Renaming to `success: false` puts the failure signal in a boolean
 * the model reads as state rather than as a presentational tag.
 * User report 2026-05-04 (Windows VM, google-api).
 */
declare function serializeToolResultAsGeminiResponse(result: any): {
    result: string;
    success: boolean;
};
export { runGeminiToolLoop, MAX_ITERATIONS, serializeToolResultAsGeminiResponse, };
