/**
 * OpenAI tool-use loop driver.
 *
 * Mirror of anthropic-api/tool-loop.js but speaks OpenAI's tool-call shape:
 *
 *   1. Send messages (with tools[]) → SDK streams content deltas + tool-call deltas
 *   2. If finish_reason === "tool_calls", collect the tool_calls list
 *   3. Execute each tool locally → build tool-result messages (role: "tool")
 *   4. Append assistant turn (with tool_calls) + tool result messages to history
 *   5. Loop until finish_reason !== "tool_calls"
 *
 * Tool execution goes through Gryphon's existing executeTool() from
 * anthropic-api/tools/tool-registry, so the protected-pattern guardrails
 * (attack-detector PreToolUse classification, permission-gate prompts,
 * per-tool input scrubbing) fire identically regardless of which provider
 * triggered the call. This is the v1.2 security parity guarantee — Stage 4
 * re-validates against synthetic GPT outputs.
 *
 * History invariant (mirrors anthropic-api/tool-loop.js): `history` is
 * mutated IN PLACE so the caller's send() can roll back to a pre-turn
 * checkpoint on thrown error. Do not clone the array internally.
 */

const { translateSchemasToOpenAI } = require("./tool-schema-translator");
const {
  getActiveTools,
  executeTool,
} = require("../anthropic-api/tools/tool-registry");

const MAX_ITERATIONS = 25;

async function runOpenAIToolLoop({
  client,
  model,
  systemPrompt,
  history,
  ctx,
  callbacks,
}: { client: any; model: any; systemPrompt: any; history: any; ctx: any; callbacks: any }) {
  // ctx.responseFormat is set by the provider when the caller passes
  // { structuredOutput: { name, schema } }. It is injected into every
  // chat.completions call in this loop so the vendor enforces the schema
  // grammar-side. It is NOT passed alongside tools — the structured-output
  // path is mutually exclusive with tool dispatch for the purposes of this
  // feature (a structuredOutput send is a single-shot request, not an
  // agentic loop). If future callers combine both, this co-exists: OpenAI
  // honours response_format on assistant text even when tools are present.
  const anthropicSchemas = getActiveTools({
    allowWrite: true,
    allowWeb: true,
    allowBash: true,
  }).map((t: any) => t.SCHEMA);
  const tools = translateSchemasToOpenAI(anthropicSchemas);

  // OpenAI returns separate prompt/completion/cached counts per call;
  // we sum across iterations so the caller sees the full turn cost.
  const totalUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  // Issue #31: peak window occupancy = last iteration's prompt_tokens.
  // OpenAI's prompt_tokens already includes the full chat history up to
  // that call, so the FINAL iteration's value is the peak — not the sum,
  // which counts the same growing history multiple times. Used by the
  // provider for `contextTokens`; `totalUsage` remains cumulative billing.
  const peakUsage = { prompt_tokens: 0 };

  let turnText = "";
  // Issue #32: text from prior iterations within this turn. When the
  // model emits prose, calls a tool, the tool is denied, then the model
  // emits a follow-up message, the bubble used to show ONLY the latest
  // iteration's text — wiping the prior prose the user had just read.
  // Carry earlier iterations' text forward so the bubble shows the full
  // turn (e.g. "summary." + "\n\n" + deny copy) instead of replacing.
  let priorTurnText = "";
  let finalMessage = null;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Build the messages array sent to OpenAI: prepend the system prompt
    // each turn (it lives outside `history`, which holds only user/assistant/tool turns).
    const messages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...history]
      : [...history];

    const streamParams: Record<string, any> = {
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream_options: { include_usage: true },
    };
    // L6 structured output: inject vendor-native response_format when set.
    // ctx.responseFormat is only present when the caller passed
    // { structuredOutput: { name, schema } } to send(). OpenAI enforces the
    // JSON schema grammar-side, so the model cannot return malformed JSON.
    if (ctx && ctx.responseFormat) {
      streamParams.response_format = ctx.responseFormat;
    }
    const stream = client.chat.completions.stream(streamParams);
    if (callbacks.onStream) callbacks.onStream(stream);

    // OpenAI's `content` event delivers (delta, snapshot) — we forward
    // the snapshot through onMessage("replace") so the chat bubble shows
    // the cumulative text without us maintaining an accumulator.
    let iterationText = "";
    stream.on("content", (_delta: any, snapshot: any) => {
      iterationText = snapshot;
      // Issue #32: include prior iterations' text in the bubble snapshot
      // so the chat-view "replace" event shows the full accumulated turn.
      turnText = priorTurnText
        ? `${priorTurnText}\n\n${iterationText}`
        : iterationText;
      if (callbacks.onMessage) callbacks.onMessage(turnText, "replace");
    });

    stream.on("error", (err: any) => {
      if (callbacks.onError) callbacks.onError(String((err && err.message) || err));
    });

    // Wait for the stream to finish — finalChatCompletion() resolves with the
    // full ChatCompletion object (incl. usage when stream_options.include_usage).
    const completion = await stream.finalChatCompletion();
    const choice = (completion.choices && completion.choices[0]) || {};
    const message = choice.message || {};
    finalMessage = { role: "assistant", content: message.content || iterationText };

    // Aggregate usage
    const u = completion.usage || {};
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) {
      totalUsage.prompt_tokens_details.cached_tokens += u.prompt_tokens_details.cached_tokens;
    }
    // Issue #31: peak = last iteration's prompt_tokens (overwrite, not add).
    peakUsage.prompt_tokens = u.prompt_tokens || 0;

    // Issue #32: fold this iteration's emitted text into the carry-forward
    // buffer BEFORE the next iteration starts a fresh `iterationText`.
    // Future iterations will prepend `priorTurnText` to their snapshot
    // so the bubble shows the full conversational turn instead of
    // overwriting earlier prose with a deny copy.
    if (iterationText) {
      priorTurnText = priorTurnText
        ? `${priorTurnText}\n\n${iterationText}`
        : iterationText;
    }

    // L5 per-call budget cap: check mid-loop after each model response.
    // SDK providers throw here; CLI providers can only check post-turn
    // (subprocess owns its internal loop; cannot abort mid-stream).
    if (ctx && ctx.maxUsdBudget !== null && ctx.computeIterationCost) {
      const iterCost = ctx.computeIterationCost(u);
      if (!ctx._loopCost) ctx._loopCost = 0;
      ctx._loopCost += iterCost;
      const callCumulative = (ctx.priorCumulativeCost || 0) + ctx._loopCost;
      if (callCumulative >= ctx.maxUsdBudget) {
        const { BudgetExceededError } = require("../../budget-error");
        throw new BudgetExceededError({
          budget: ctx.maxUsdBudget,
          spent: callCumulative,
          lastTurnCost: iterCost,
        });
      }
    }

    // Append assistant turn to history. OpenAI requires preserving
    // tool_calls verbatim on the assistant message so subsequent tool
    // results can reference them by id.
    const assistantTurn: Record<string, any> = { role: "assistant" };
    // OpenAI's API requires `content` to be present (string or null) on
    // assistant messages — never undefined.
    assistantTurn.content = (message.content === undefined ? null : message.content);
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      assistantTurn.tool_calls = message.tool_calls;
    }
    history.push(assistantTurn);

    // Stop reasons: "stop" (normal end), "length" (max_tokens), "tool_calls"
    if (choice.finish_reason !== "tool_calls") {
      return { turnText, finalMessage, totalUsage, peakUsage, iterations };
    }

    // Execute tool calls. Each call has shape:
    //   { id, type: "function", function: { name, arguments: <JSON string> } }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      // finish_reason said tool_calls but list is empty — defensive exit
      console.warn("[gryphon/openai] finish_reason=tool_calls with no tool_calls present");
      return { turnText, finalMessage, totalUsage, peakUsage, iterations };
    }

    for (const call of toolCalls) {
      if (call.type !== "function") {
        // Future tool types (e.g., file_search, code_interpreter) are not
        // wired up — synthesize a tool error message so the model isn't stuck.
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: tool type "${call.type}" is not supported by Gryphon.`,
        });
        continue;
      }

      const name = call.function && call.function.name;
      const argsRaw = (call.function && call.function.arguments) || "{}";
      let input;
      try {
        input = JSON.parse(argsRaw);
      } catch (e) {
        // The model emitted malformed JSON — return a tool error so it
        // can self-correct rather than throwing the loop.
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: tool arguments were not valid JSON. Got: ${argsRaw.slice(0, 200)}`,
        });
        continue;
      }

      if (callbacks.onTool) callbacks.onTool(name);
      const result = await executeTool(name, input, ctx);

      // Translate Anthropic-shape tool_result content (array of {type, text})
      // into the single string OpenAI expects on `role: "tool"` messages.
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResultContent(result),
      });
    }
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
 * Convert the Anthropic-shape tool result `content` array into the single
 * string OpenAI expects on `role: "tool"` messages. Any `is_error` flag is
 * surfaced inline as a prefix so the model can still recognize errors —
 * OpenAI's `role: "tool"` shape doesn't have a structured error field.
 */
function serializeToolResultContent(result: any) {
  if (!result) return "";
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block) continue;
      if (typeof block.text === "string") parts.push(block.text);
    }
  } else if (typeof result.content === "string") {
    parts.push(result.content);
  }
  const body = parts.join("");
  if (result.isError) {
    // Same prefix anthropic-api uses in its is_error tool_result for
    // model-recognizable consistency across providers.
    return `[tool error] ${body}`;
  }
  return body;
}

module.exports = {
  runOpenAIToolLoop,
  MAX_ITERATIONS,
  // exported for unit tests
  serializeToolResultContent,
};
