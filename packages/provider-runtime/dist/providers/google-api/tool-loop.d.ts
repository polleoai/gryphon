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
export {};
