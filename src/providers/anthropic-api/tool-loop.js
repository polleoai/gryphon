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

const { getToolSchemas, executeTool } = require("./tools/tool-registry");

const MAX_ITERATIONS = 25;

// System prompt sent with every SDK-mode request. Covers four observed
// model failure modes: (1) paraphrasing the deny reason instead of
// quoting it verbatim, (2) improvising "this path is probably a typo"
// speculation, (3) suggesting File Explorer / Command Prompt
// workarounds that the user's protected-pattern choice was meant to
// prevent, (4) occasionally stopping silently after a tool refusal
// (surfaces as "(No response)" in the chat). Fourth one matters
// because Claude's `stop_reason` after a tool_result with is_error=true
// is sometimes just an immediate end_turn with no text content, and
// the user sees nothing.
//
// No mention of "Claude Code", "hooks", or "~/.claude" here — this is
// the SDK path, so the CLI-specific vocabulary from
// GRYPHON_SYSTEM_PROMPT_HINT (claude-code.js) doesn't apply.
const GRYPHON_SDK_SYSTEM_PROMPT =
  "You are running inside the Gryphon Obsidian plugin. The user's " +
  "own protected-pattern list inside Gryphon decides which file " +
  "paths and shell commands require approval or are refused. " +
  "· When a tool returns a refusal with a `reason` field, output " +
  "ONLY that reason to the user — no preamble before it (no " +
  "\"The Gryphon plugin is blocking this\", no \"The Gryphon hook\", " +
  "no \"You'll need to first\"), and no epilogue after it (no " +
  "\"I can't bypass this\", no \"it's enforced by the Gryphon " +
  "plugin\", no \"once you've done that, I can proceed\"). The " +
  "reason is self-contained; anything you add degrades it. " +
  "· Do not paraphrase, add context about the enforcement " +
  "mechanism, expand with your own theories, or suggest alternative " +
  "workarounds (File Explorer, Command Prompt, PowerShell, manual " +
  "deletion, admin elevation). The reason tells the user exactly " +
  "how to adjust settings if they want to allow the operation. " +
  "· Do not speculate that the path might be a typo, might not " +
  "exist, or might not be a standard system path. The refusal is " +
  "about a pattern match, not path validity. " +
  "· Always produce a text response after a tool refusal or error " +
  "— never end your turn silently. At minimum, echo the reason. " +
  "· Never use the words \"hook\", \"hooks\", \"pre-tool\", " +
  "\"PreToolUse\", \"PostToolUse\", \"intercept\", \"IPC\", " +
  "\"enforced by\", \"before the command runs\", \"bypass\", or " +
  "any description of how Gryphon checks for protected patterns. " +
  "Say plainly that the operation matched one of the user's " +
  "protected patterns, and point them at Settings → Gryphon to " +
  "adjust the list.";

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
async function runToolLoop({ client, model, history, ctx, callbacks }) {
  const tools = getToolSchemas({
    allowWrite: true,   // Phase 4: Write + Edit (gated per-tool by permissionMode)
    allowWeb: true,     // Phase 5: WebFetch + WebSearch
    allowBash: true,    // Phase 5: Bash (always prompts in default mode)
  });

  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  let turnText = "";
  let finalMessage = null;
  let iterations = 0;
  // Issue #4: thinking blocks accumulated across loop iterations. Each
  // iteration's finalMessage.content can carry `thinking` /
  // `redacted_thinking` blocks; we extract them so chat-view can persist
  // and surface them as a collapsible section on the assistant bubble.
  const thinkingBlocks = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      system: GRYPHON_SDK_SYSTEM_PROMPT,
      tools: tools.length > 0 ? tools : undefined,
      messages: history,
    });
    if (callbacks.onStream) callbacks.onStream(stream);

    // Reset turnText each iteration: the streaming bubble shows ONLY the
    // assistant's most recent text block, not concatenated tool dialogue.
    // (Tool results don't render to the user; they go back into history.)
    let iterationText = "";
    stream.on("text", (delta) => {
      iterationText += delta;
      turnText = iterationText;
      if (callbacks.onMessage) callbacks.onMessage(turnText, "replace");
    });

    stream.on("error", (err) => {
      if (callbacks.onError) callbacks.onError(String(err?.message || err));
    });

    finalMessage = await stream.finalMessage();

    // Aggregate usage
    const u = finalMessage.usage || {};
    totalUsage.input_tokens += u.input_tokens || 0;
    totalUsage.output_tokens += u.output_tokens || 0;
    totalUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    totalUsage.cache_read_input_tokens += u.cache_read_input_tokens || 0;

    // Issue #4: harvest thinking blocks for cross-provider parity.
    if (Array.isArray(finalMessage.content)) {
      for (const b of finalMessage.content) {
        if (!b) continue;
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
          thinkingBlocks.push(b.thinking);
        } else if (b.type === "redacted_thinking") {
          thinkingBlocks.push("[redacted thinking]");
        }
      }
    }

    // Append assistant turn to history (always — tool_use or end_turn)
    history.push({ role: "assistant", content: finalMessage.content });

    if (finalMessage.stop_reason !== "tool_use") {
      // Pure text response — we're done
      return { turnText, finalMessage, totalUsage, iterations, thinkingBlocks };
    }

    // Execute all tool_use blocks from this turn
    const toolUseBlocks = finalMessage.content.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      // stop_reason said tool_use but no blocks present — defensive exit
      console.warn("[gryphon/sdk] stop_reason=tool_use but no tool_use blocks");
      return { turnText, finalMessage, totalUsage, iterations, thinkingBlocks };
    }

    const toolResults = [];
    for (const block of toolUseBlocks) {
      if (callbacks.onTool) callbacks.onTool(block.name);
      const result = await executeTool(block.name, block.input, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: !!result.isError,
      });
    }

    // Feed tool results back as the next user turn
    history.push({ role: "user", content: toolResults });
    // Loop continues
  }

  // Hit the iteration cap — surface as an error-shaped result
  if (callbacks.onError) {
    callbacks.onError(`Tool loop exceeded ${MAX_ITERATIONS} iterations — stopping. The model may be stuck in a tool loop.`);
  }
  return { turnText, finalMessage, totalUsage, iterations, thinkingBlocks };
}

module.exports = { runToolLoop, MAX_ITERATIONS };
