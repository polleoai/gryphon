/**
 * GoogleProvider — implements the LLMProvider contract via the official
 * `@google/genai` npm SDK (Gemini API).
 *
 * Stage 3 — second hand-built non-Anthropic adapter. Mirrors the structure
 * of OpenAIProvider deliberately so the chat-view doesn't need provider-
 * specific branches.
 *
 * The Gemini API is stateless (chat history must be replayed each turn).
 * Streaming uses `client.models.generateContentStream(...)` which returns
 * an async generator of GenerateContentResponse chunks; the provider
 * forwards accumulated text snapshots through onMessage(text, "replace").
 *
 * Tool support lives in `tool-loop.js`. The provider's `send` delegates
 * to `runGeminiToolLoop`, which speaks Gemini's functionCall/functionResponse
 * shape but reuses Gryphon's existing tool registry — security parity.
 *
 * Cost calculation: SDK reports promptTokenCount / candidatesTokenCount /
 * cachedContentTokenCount; pricing.js computeCost() converts to USD.
 */

const { GoogleGenAI } = require("@google/genai");
const { runGeminiToolLoop } = require("./tool-loop");
const { resolveModel, coerceToVendorModel, computeCost, DEFAULT_MODEL } = require("./pricing");
const { testApiKey } = require("./test-key");

const GRYPHON_GEMINI_SYSTEM_PROMPT =
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

class GoogleProvider {
  constructor(apiKey, cwd, options = {}) {
    if (!apiKey) {
      throw new Error("GoogleProvider: apiKey is required");
    }
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.options = options;

    // Test seam: callers may inject a mock client. Otherwise construct
    // the real Gemini SDK client. The API surface used here is
    // `client.models.generateContentStream({...})`.
    this.client = options.client || new GoogleGenAI({ apiKey });

    // Gemini's chat history shape: alternating Content { role, parts }.
    // role is "user" | "model" (NOT "assistant").
    this.history = Array.isArray(options.initialHistory)
      ? options.initialHistory.map((c) => cloneGeminiContent(c))
      : [];

    this.sessionId = `gemini-sdk-${Date.now()}`;  // synthetic — SDK is stateless
    // coerceToVendorModel rejects cross-vendor leak (e.g. settings.model
    // carrying "gpt-4o-mini" from prior OpenAI use without a Settings →
    // Provider onChange to reset it). See issue #27.
    this.resolvedModel = coerceToVendorModel(options.model);
    this.contextTokens = 0;
    this.cumulativeCost = 0;
    this.startTime = Date.now();

    this.activeStream = null;
    this.pending = false;
    this.destroyed = false;

    this.onMessage = null;
    this.onError = null;
    this.onDone = null;
  }

  isAlive() { return !this.destroyed; }

  // Gemini mode: cost is computed locally from token usage × MODEL_PRICES.
  // The price table may drift from Google's published pricing between
  // Gryphon releases. Cached-token discounts are tracked but not applied
  // (per v1.2 design decision). UI labels Gemini costs as "(est.)" so
  // users know to check ai.google.dev/usage for authoritative billing.
  get costIsEstimate() { return true; }

  abort() {
    if (this.activeStream) {
      // The Gemini SDK's async generator doesn't expose a synchronous
      // abort the way OpenAI's stream does. Closest equivalent: call
      // .return() to signal the iterator to terminate. The for-await
      // loop in runGeminiToolLoop will exit on the next iteration.
      try {
        if (typeof this.activeStream.return === "function") {
          this.activeStream.return();
        }
      } catch {}
      this.activeStream = null;
    }
    this.pending = false;
    this.destroyed = true;
  }

  /**
   * **Concurrency invariant** (BT-6 Round 18, BT-3 Round 20): callers MUST
   * serialize `send()` invocations against the SAME provider instance.
   * The chat-view does this via the `isStreaming` enqueue gate
   * (chat-view.js:3653). Without that gate, a second `send()` while the
   * first is awaiting would clobber `pending`, `activeStream`, and
   * `historyCheckpoint` — the second send's user message could be truncated
   * by the first send's error rollback. Inherited from openai-api / anthropic-api.
   */
  async send(prompt) {
    if (this.pending) {
      this.abort();
    }
    this.pending = true;

    const historyCheckpoint = this.history.length;
    // Gemini user turn: { role: "user", parts: [{ text }] }.
    this.history.push({ role: "user", parts: [{ text: prompt }] });

    if (this.onMessage) this.onMessage("", "init");

    const turnStart = Date.now();
    const ctx = {
      vaultRoot: this.cwd,
      permissionMode: this.options.permissionMode || "default",
      plugin: this.options.plugin || null,
    };

    try {
      const { turnText, finalMessage, totalUsage } = await runGeminiToolLoop({
        client: this.client,
        model: this.resolvedModel,
        systemPrompt: GRYPHON_GEMINI_SYSTEM_PROMPT,
        history: this.history,
        ctx,
        callbacks: {
          onMessage: (text, type) => {
            if (this.onMessage) this.onMessage(text, type);
          },
          onTool: (name) => {
            if (this.onMessage) this.onMessage(name, "tool");
          },
          onError: (text) => {
            if (this.onError) this.onError(text);
          },
          onStream: (stream) => {
            this.activeStream = stream;
          },
        },
      });

      this.activeStream = null;
      this.pending = false;

      const { cost: turnCost } = computeCost(totalUsage, this.resolvedModel);
      this.cumulativeCost += turnCost;
      this.contextTokens = (totalUsage && totalUsage.promptTokenCount) || 0;

      const result = {
        text: turnText || _extractFinalText(finalMessage) || "",
        cost: turnCost,
        cumulativeCost: this.cumulativeCost,
        sessionId: this.sessionId,
        duration: Date.now() - turnStart,
        contextTokens: this.contextTokens,
      };

      if (this.onDone) this.onDone(result);
      return result;
    } catch (err) {
      this.activeStream = null;
      this.pending = false;
      this.history.length = historyCheckpoint;
      if (this.onError) this.onError(this._formatError(err));
      throw err;
    }
  }

  _formatError(err) {
    // Gemini SDK errors don't have a stable class hierarchy — sniff via
    // status code + message keywords. The most common case (bad key) is
    // a 400 with API_KEY_INVALID in the message.
    const status = err && (err.status || err.statusCode);
    const msg = String((err && err.message) || err);

    if (/API[_ ]KEY[_ ]INVALID|Invalid API key/i.test(msg) || status === 401 || status === 403) {
      return "Invalid API key. Check Settings → Gryphon → Google API key.";
    }
    if (status === 429) {
      return "Rate limited by Google. Check your AI Studio quota at aistudio.google.com.";
    }
    if (status) {
      return `Google Gemini API error (${status}): ${msg}`;
    }
    return msg;
  }
}

/**
 * Normalize an incoming history entry into Gemini's Content shape.
 *
 * Chat-view's `_extractLlmTurnsFromFullHistory` produces Anthropic/OpenAI-shape
 * entries: `{ role: "user" | "assistant", content: <text> }`. Gemini rejects
 * `role: "assistant"` (its valid roles are USER and MODEL) and expects parts
 * not content. We translate at the GoogleProvider boundary so the chat-view
 * stays provider-agnostic.
 *
 * Already-Gemini-shaped entries (`{ role: "user" | "model", parts: [...] }`)
 * pass through deep-cloned. Mixed shapes (a `parts` array on a "assistant"
 * role, etc.) are normalized too — `assistant` always rewrites to `model`.
 */
function cloneGeminiContent(content) {
  // Map role: "assistant" → "model"; "user" stays "user"; anything else
  // falls through to "user" (defensive — better than emitting an unknown
  // role which Gemini would reject with the same 400).
  const rawRole = content && content.role;
  const role = rawRole === "model" ? "model"
             : rawRole === "assistant" ? "model"
             : "user";

  let parts;
  if (Array.isArray(content && content.parts) && content.parts.length > 0) {
    parts = JSON.parse(JSON.stringify(content.parts));
  } else if (typeof (content && content.content) === "string") {
    // Anthropic/OpenAI-shape: { role, content: <text> } → wrap in a text part.
    parts = [{ text: content.content }];
  } else if (typeof (content && content.text) === "string") {
    // Defensive: { role, text } variant.
    parts = [{ text: content.text }];
  } else {
    parts = [];
  }

  return { role, parts };
}

function _extractFinalText(finalMessage) {
  if (!finalMessage || !Array.isArray(finalMessage.parts)) return "";
  return finalMessage.parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

module.exports = { GoogleProvider, testApiKey, resolveModel, DEFAULT_MODEL };
