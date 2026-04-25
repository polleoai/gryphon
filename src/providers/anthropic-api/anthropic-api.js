/**
 * AnthropicAPIProvider — implements the LLMProvider contract via the
 * official @anthropic-ai/sdk client.
 *
 * Phase 2: pure chat (no tool use). The provider maintains the message
 * history client-side (the API is stateless) and streams responses
 * through the contract's onMessage/onError/onDone callbacks. Tool support
 * lands in Phase 3 (read-only) and Phase 4 (read-write).
 *
 * Authentication: caller passes apiKey at construction. Source priority
 * (settings field → ANTHROPIC_API_KEY env) is the factory's job, not ours.
 *
 * Cost calculation: SDK reports token usage; we multiply by a per-model
 * price table to estimate per-turn cost. Price table is approximate and
 * lives in MODEL_PRICES below — keep in sync with Anthropic's pricing
 * page when it changes.
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const { runToolLoop } = require("./tool-loop");

// USD per million tokens. Update when Anthropic's pricing changes.
// Cache write defaults to 1.25× input (5min ephemeral); cache read is
// 0.1× input. We don't request 1h cache writes anywhere yet.
const MODEL_PRICES = {
  "claude-haiku-4-5":  { input: 0.80,  output: 4.00 },
  "claude-sonnet-4-6": { input: 3.00,  output: 15.00 },
  "claude-opus-4-7":   { input: 15.00, output: 75.00 },
  // Fallback for unknown model IDs — assume Sonnet pricing
  "_default":          { input: 3.00,  output: 15.00 },
};

// Map our internal model aliases to concrete API model IDs. The CLI does
// this resolution server-side; in Anthropic API mode we do it explicitly.
const MODEL_ALIAS = {
  "haiku":      "claude-haiku-4-5",
  "sonnet":     "claude-sonnet-4-6",
  "opus":       "claude-opus-4-7",
  "opus[1m]":   "claude-opus-4-7",  // 1M context flag handled separately if needed
};

function resolveModel(alias) {
  return MODEL_ALIAS[alias] || alias || "claude-sonnet-4-6";
}

function priceFor(modelId) {
  return MODEL_PRICES[modelId] || MODEL_PRICES._default;
}

function computeCost(usage, modelId) {
  if (!usage) return 0;
  const p = priceFor(modelId);
  const inputTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) * 1.25 +  // write premium
    (usage.cache_read_input_tokens || 0) * 0.1;        // read discount
  const outputTokens = usage.output_tokens || 0;
  return (inputTokens / 1_000_000) * p.input +
         (outputTokens / 1_000_000) * p.output;
}

class AnthropicAPIProvider {
  constructor(apiKey, cwd, options = {}) {
    if (!apiKey) {
      throw new Error("AnthropicAPIProvider: apiKey is required");
    }
    this.apiKey = apiKey;
    this.cwd = cwd;  // unused in Phase 2 — relevant once tools land
    this.options = options;

    // dangerouslyAllowBrowser: required because Obsidian's renderer process
    // exposes the `window` global, which the SDK treats as "browser-like"
    // and refuses by default. The SDK's threat model (API key leaking via
    // XSS or devtools shipped to end users) doesn't apply to Obsidian
    // plugins — the key lives in plugin data.json on the user's own disk
    // and is never sent anywhere except Anthropic's API.
    //
    // maxRetries: the SDK automatically retries on 408/409/429/>=500 with
    // exponential backoff (respecting Retry-After headers). Default is 2;
    // we raise to 3 so transient rate-limits during a long agentic turn
    // don't surface to the user as hard errors. A full tool-use loop can
    // issue ~10-25 API calls and rate-limits hit more often than single-
    // shot chats, so the extra retry buys real reliability.
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
      maxRetries: 3,
    });

    // Seed from persisted history if the caller (chat-view after reload)
    // supplies it. Defensive copy — provider mutates history in place and
    // shouldn't leak those mutations back to the caller's array.
    this.history = Array.isArray(options.initialHistory)
      ? options.initialHistory.map((m) => ({ role: m.role, content: m.content }))
      : [];
    this.sessionId = `sdk-${Date.now()}`; // synthetic — SDK is stateless
    this.resolvedModel = resolveModel(options.model);
    this.contextTokens = 0;
    this.cumulativeCost = 0;
    this.startTime = Date.now();

    this.activeStream = null;
    this.pending = false;
    // `destroyed` is the SDK's equivalent of "subprocess exited." Unlike
    // Claude Code mode where the subprocess staying open is what keeps the session
    // alive between turns, SDK history lives on this instance — so the
    // instance itself is the session. isAlive() must stay true across
    // completed turns so chat-view reuses this provider instead of
    // spawning a fresh one with empty history. Explicit teardown via
    // abort() flips destroyed=true and forces a new instance next turn.
    this.destroyed = false;

    this.onMessage = null;
    this.onError = null;
    this.onDone = null;
  }

  isAlive() { return !this.destroyed; }

  // Anthropic API mode: cost is computed locally from token usage × MODEL_PRICES.
  // The price table in this file may drift from Anthropic's published
  // pricing between Gryphon releases, and cache discounts are estimated
  // (we assume 5-min ephemeral cache: 1.25× write, 0.10× read). UI labels
  // SDK costs as "(est.)" so users know to check console.anthropic.com
  // for authoritative billing.
  get costIsEstimate() { return true; }

  abort() {
    if (this.activeStream) {
      try { this.activeStream.abort(); } catch {}
      this.activeStream = null;
    }
    this.pending = false;
    // Abort tears down the session. A new turn on the same provider
    // after abort() would still "work" (history preserved), but the
    // chat-view's convention is that abort = teardown, so mark destroyed
    // to force a fresh provider next turn. This also matches CLI's
    // abort() which kills the subprocess irrecoverably.
    this.destroyed = true;
  }

  async send(prompt) {
    if (this.pending) {
      // Caller started a new turn before previous resolved — abort old.
      this.abort();
    }
    this.pending = true;
    // Snapshot the history length so we can roll back on error to the
    // state before this turn started — including any tool_use loop turns
    // the failure left half-applied.
    const historyCheckpoint = this.history.length;
    this.history.push({ role: "user", content: prompt });

    // Signal "init" so chat-view transitions from "Connecting" to "Thinking"
    if (this.onMessage) this.onMessage("", "init");

    const turnStart = Date.now();
    const ctx = {
      vaultRoot: this.cwd,
      permissionMode: this.options.permissionMode || "default",
      plugin: this.options.plugin || null,
    };

    try {
      const { turnText, finalMessage, totalUsage } = await runToolLoop({
        client: this.client,
        model: this.resolvedModel,
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

      const turnCost = computeCost(totalUsage, this.resolvedModel);
      this.cumulativeCost += turnCost;
      this.contextTokens =
        (totalUsage.input_tokens || 0) +
        (totalUsage.cache_creation_input_tokens || 0) +
        (totalUsage.cache_read_input_tokens || 0);

      // Prefer streaming-accumulated text (turnText). If the API ever
      // returns a response that produced no text deltas in-flight but
      // still carries text-like content in its block list — e.g. future
      // block types we don't yet unpack in the streaming handler —
      // _extractText sweeps every block that has a `.text` field so the
      // UI shows something rather than a blank "(No response)".
      const extracted = this._extractText(finalMessage && finalMessage.content);
      const result = {
        text: turnText || extracted,
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
      // Roll back history to the pre-turn snapshot — drops the user
      // message we pushed plus any partial assistant/tool_result turns
      // the loop produced before failing. A retry of send() should
      // start from the same state as before this call.
      this.history.length = historyCheckpoint;
      if (this.onError) this.onError(this._formatError(err));
      throw err;
    }
  }

  _extractText(content) {
    if (!Array.isArray(content)) return "";
    // Primary: pick known `text` blocks. Secondary: any block that
    // carries a `.text` string — covers forward-compatible block shapes
    // (thinking/redacted_thinking, future block types) so the UI doesn't
    // render "(No response)" when the API actually returned content we
    // just don't recognize by discriminator.
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type !== "tool_use" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("");
  }

  _formatError(err) {
    if (err instanceof Anthropic.APIError) {
      if (err instanceof Anthropic.AuthenticationError) {
        return "Invalid API key. Check Settings → Gryphon → Anthropic API key.";
      }
      if (err instanceof Anthropic.RateLimitError) {
        // If we're seeing this error, the SDK already exhausted its
        // auto-retries. Tell the user something actionable rather than
        // "try again in a moment" (which the SDK already did).
        const retryAfter = err.headers && err.headers.get && err.headers.get("retry-after");
        const hint = retryAfter
          ? `Retry-After header says ${retryAfter} seconds.`
          : "Check your Anthropic usage dashboard for current rate limits.";
        return `Rate limited by Anthropic after 3 automatic retries. ${hint}`;
      }
      if (err instanceof Anthropic.BadRequestError) {
        return `Bad request: ${err.message}`;
      }
      return `Anthropic API error (${err.status || "?"}): ${err.message}`;
    }
    return String(err?.message || err);
  }
}

/**
 * Validate an API key by making a trivial /messages call. Used by the
 * "Test key" button in settings. Returns { ok, message }.
 */
async function testApiKey(apiKey) {
  if (!apiKey) return { ok: false, message: "No API key provided" };
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true, message: "Key works" };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, message: "Invalid API key" };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, message: `API error (${err.status || "?"}): ${err.message}` };
    }
    return { ok: false, message: String(err?.message || err) };
  }
}

module.exports = { AnthropicAPIProvider, testApiKey, resolveModel };
