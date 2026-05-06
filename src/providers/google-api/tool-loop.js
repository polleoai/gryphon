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

const { translateSchemasToGemini } = require("./tool-schema-translator");
const {
  getActiveTools,
  executeTool,
} = require("../anthropic-api/tools/tool-registry");

const MAX_ITERATIONS = 25;

async function runGeminiToolLoop({
  client,
  model,
  systemPrompt,
  history,
  ctx,
  callbacks,
}) {
  const anthropicSchemas = getActiveTools({
    allowWrite: true,
    allowWeb: true,
    allowBash: true,
  }).map((t) => t.SCHEMA);
  // Gemini wants a single tools[] entry containing all functionDeclarations.
  const toolsConfig = anthropicSchemas.length > 0
    ? [translateSchemasToGemini(anthropicSchemas)]
    : undefined;

  // Aggregate token usage across iterations. Gemini's GenerateContentResponse
  // uses promptTokenCount / candidatesTokenCount; cachedContentTokenCount
  // surfaces when prompt-cache hits land.
  const totalUsage = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    cachedContentTokenCount: 0,
  };
  // Issue #31: peak window occupancy = last iteration's promptTokenCount.
  // Gemini's promptTokenCount already includes the full `contents` history
  // at the call, so the FINAL iteration's value is the peak — not the sum,
  // which counts the same growing history multiple times. Used by the
  // provider for `contextTokens`; `totalUsage` remains cumulative billing.
  const peakUsage = { promptTokenCount: 0 };

  let turnText = "";
  // Issue #32: text accumulated from prior iterations within this turn.
  // Mirrors the SDK Anthropic + OpenAI loops — when the model emits prose,
  // calls a tool that gets denied, then emits a follow-up message, the
  // bubble preserves the earlier prose instead of having it overwritten.
  let priorTurnText = "";
  let finalMessage = null;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Gemini's `contents` is the full chat history; system instruction lives
    // separately in `config.systemInstruction`. History items are role
    // "user" or "model" (NOT "assistant" — that's OpenAI).
    const stream = await client.models.generateContentStream({
      model,
      contents: history,
      config: {
        systemInstruction: systemPrompt || undefined,
        tools: toolsConfig,
      },
    });
    if (callbacks.onStream) callbacks.onStream(stream);

    let iterationText = "";
    const collectedParts = [];   // assistant ("model") parts assembled across chunks
    let lastUsage = null;
    let lastFinishReason = null;

    for await (const chunk of stream) {
      const candidate = chunk.candidates && chunk.candidates[0];
      if (candidate) {
        const parts = (candidate.content && candidate.content.parts) || [];
        for (const part of parts) {
          if (typeof part.text === "string" && part.text.length > 0) {
            iterationText += part.text;
            // Issue #32: prepend prior iterations' text so the bubble shows
            // the full turn (not just the latest segment).
            turnText = priorTurnText
              ? `${priorTurnText}\n\n${iterationText}`
              : iterationText;
            if (callbacks.onMessage) callbacks.onMessage(turnText, "replace");
          }
          // functionCalls accumulate verbatim — we'll dispatch them after
          // the stream completes (they only fire when the model decides to
          // call a tool, and the SDK delivers them as complete part objects
          // not delta-streamed text). Empty-text parts are dropped (BT-1
          // Round 20) so an all-whitespace history doesn't accumulate.
          if (part.functionCall) collectedParts.push(part);
          else if (typeof part.text === "string" && part.text.length > 0) {
            collectedParts.push(part);
          }
        }
        if (candidate.finishReason) lastFinishReason = candidate.finishReason;
      }
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
    }

    // Aggregate usage from the final chunk that carried it.
    if (lastUsage) {
      totalUsage.promptTokenCount += lastUsage.promptTokenCount || 0;
      totalUsage.candidatesTokenCount += lastUsage.candidatesTokenCount || 0;
      totalUsage.cachedContentTokenCount += lastUsage.cachedContentTokenCount || 0;
      // Issue #31: peak = last iteration's promptTokenCount (overwrite, not add).
      peakUsage.promptTokenCount = lastUsage.promptTokenCount || 0;
    }

    // Issue #32: fold this iteration's emitted text into the carry-forward
    // buffer BEFORE the next iteration's `iterationText` resets. Future
    // iterations will prepend `priorTurnText` to their snapshot.
    if (iterationText) {
      priorTurnText = priorTurnText
        ? `${priorTurnText}\n\n${iterationText}`
        : iterationText;
    }

    // Append the model's turn to history so subsequent iterations + future
    // turns see what was said. If iterationText has content but collectedParts
    // is empty (defensive), synthesize a text part so history stays valid.
    const partsForHistory = collectedParts.length > 0
      ? collectedParts
      : (iterationText ? [{ text: iterationText }] : []);

    // Round 20 F24-1 fix: skip empty-parts model turns. Gemini's API rejects
    // `{ role: "model", parts: [] }` with INVALID_ARGUMENT 400 on the next
    // request that includes it. This case fires when the stream finishes
    // with no text + no functionCalls (e.g. SAFETY / RECITATION block, or
    // upstream truncation). The finishReason diagnostic via onError below
    // is sufficient signal to the user; the empty turn would only poison
    // the in-memory history for subsequent same-session sends.
    if (partsForHistory.length > 0) {
      finalMessage = { role: "model", parts: partsForHistory };
      history.push(finalMessage);
    } else {
      // Preserve a minimal finalMessage for the caller's `text` fallback,
      // but DO NOT push it to history.
      finalMessage = { role: "model", parts: [] };
    }

    // Pull function-call parts for dispatch.
    const functionCalls = collectedParts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall);

    if (functionCalls.length === 0) {
      // No tool calls → done. Honour finishReason for diagnostic surfacing.
      if (lastFinishReason && lastFinishReason !== "STOP" && callbacks.onError) {
        // MAX_TOKENS / SAFETY / etc. — not fatal, but the user should know
        // the response was clipped or filtered.
        callbacks.onError(`Gemini stopped with finishReason=${lastFinishReason}.`);
      }
      return { turnText, finalMessage, totalUsage, peakUsage, iterations };
    }

    // Dispatch tool calls. Gryphon's executeTool returns Anthropic-shape
    // `{ content: [{type:"text", text}], isError }` — we serialize that
    // into a Gemini functionResponse `response` object.
    const responseParts = [];
    for (const call of functionCalls) {
      const name = call.name;
      const input = call.args || {};
      const callId = call.id; // optional per Gemini contract; preserve when present

      if (callbacks.onTool) callbacks.onTool(name);
      const result = await executeTool(name, input, ctx);

      const responseObj = serializeToolResultAsGeminiResponse(result);
      const part = { functionResponse: { name, response: responseObj } };
      if (callId) part.functionResponse.id = callId;
      responseParts.push(part);
    }

    // Tool results land as a single user-role Content with all
    // functionResponse parts — Gemini's expected shape for the next turn.
    history.push({ role: "user", parts: responseParts });
    // Loop continues — model sees the tool results next iteration.
  }

  // Hit the iteration cap
  if (callbacks.onError) {
    callbacks.onError(
      `Tool loop exceeded ${MAX_ITERATIONS} iterations — stopping. The model may be stuck in a tool loop.`,
    );
  }
  return { turnText, finalMessage, totalUsage, peakUsage, iterations };
}

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
function serializeToolResultAsGeminiResponse(result) {
  if (!result) return { result: "", success: true };
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && typeof block.text === "string") parts.push(block.text);
    }
  } else if (typeof result.content === "string") {
    parts.push(result.content);
  }
  const body = parts.join("");
  if (result.isError) return { result: body, success: false };
  return { result: body, success: true };
}

module.exports = {
  runGeminiToolLoop,
  MAX_ITERATIONS,
  serializeToolResultAsGeminiResponse,
};
