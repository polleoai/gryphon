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
 * price table to estimate per-turn cost. The price table lives in the
 * canonical registry at `packages/provider-config/src/registry.js` — update
 * that file when Anthropic's pricing changes, and run
 * `scripts/probe-model.sh anthropic <id>` for any newly-added model id.
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const { runToolLoop, GRYPHON_SDK_SYSTEM_PROMPT } = require("./tool-loop") as typeof import("./tool-loop");
const { getToolSchemas } = require("./tools/tool-registry") as typeof import("./tools/tool-registry");

// Pricing + alias resolution lives in @gryphon/provider-config (v2.2).
// We import the helpers and re-export the names this module's consumers
// rely on (notably `resolveModel`, which the factory imports).
const {
  MODEL_PRICES,
  MODEL_ALIAS,
  DEFAULT_MODEL,
  resolveModel,
  priceFor,
  computeCost,
} = require("@gryphon/provider-config").pricing.anthropic;

class AnthropicAPIProvider {
  [key: string]: any;
  constructor(apiKey: any, cwd: any, options: Record<string, any> = {}) {
    if (!apiKey) {
      throw new Error("AnthropicAPIProvider: apiKey is required");
    }
    this.apiKey = apiKey;
    this.cwd = cwd;  // unused in Phase 2 — relevant once tools land
    this.options = options;
    this.hostAdapter = options.hostAdapter ||
      new ((require("../../host-adapter") as typeof import("../../host-adapter")).HeadlessHostAdapter)();

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

  /**
   * Build the request body for `messages.countTokens` — authoritative
   * pre-send count of input tokens for the NEXT turn if it were sent
   * with `prospectiveInput` as the user message.
   *
   * Split out from `countTokensForNext` so unit tests can verify the
   * request shape (system prompt, tool list, message order) without
   * needing an Anthropic client. The Stage A heuristic estimator is the
   * fallback when this network call isn't available — the SDK number
   * here is authoritative when present.
   *
   * The empty-prospective-input case is special-cased: the API rejects
   * an empty user message, so we pass a single space (1-token cost) just
   * to keep the request well-formed. The chat-view caller treats the
   * difference as noise.
   *
   * @param {string} prospectiveInput  — text the user has typed but not sent
   * @returns {object} — `{ model, system, tools, messages }`
   */
  _buildCountTokensRequest(prospectiveInput: any) {
    const text = (typeof prospectiveInput === "string" && prospectiveInput.length > 0)
      ? prospectiveInput
      : " ";
    const messages = [
      ...this.history,
      { role: "user", content: text },
    ];
    const tools = getToolSchemas({ allowWrite: true, allowWeb: true, allowBash: true });
    const body: Record<string, any> = {
      model: this.resolvedModel,
      system: GRYPHON_SDK_SYSTEM_PROMPT,
      messages,
    };
    if (tools.length > 0) body.tools = tools;
    return body;
  }

  /**
   * Authoritative pre-send token count for SDK mode (F1).
   *
   * Calls Anthropic's `messages.countTokens` endpoint with the same
   * arguments `send()` would use, plus a prospective user message. Cheap
   * — no generation, no streaming, one network roundtrip — but still
   * worth caching against repeated typing on the same prefix.
   *
   * Returns `null` on any failure (network, auth, rate-limit, SDK
   * version that doesn't support countTokens). The chat-view falls back
   * to the heuristic estimator on null.
   *
   * @param {string} prospectiveInput
   * @returns {Promise<number|null>}  input_tokens, or null on failure
   */
  async countTokensForNext(prospectiveInput: any) {
    // Cache key — keyed on history length (cheap proxy for content
    // identity) and the prospective input itself. Two consecutive calls
    // with the same prefix while the user pauses typing return cached;
    // changing the input even by a single char busts the cache.
    const cacheKey = `${this.history.length}|${prospectiveInput || ""}`;
    if (this._countTokensCache && this._countTokensCache.key === cacheKey) {
      return this._countTokensCache.value;
    }
    try {
      const body = this._buildCountTokensRequest(prospectiveInput);
      const result = await this.client.messages.countTokens(body);
      const tokens = (result && typeof result.input_tokens === "number")
        ? result.input_tokens : null;
      this._countTokensCache = { key: cacheKey, value: tokens };
      return tokens;
    } catch (_) {
      // Caller's fallback path uses the heuristic estimator. Don't
      // surface the error — countTokens failing shouldn't block typing.
      this._countTokensCache = { key: cacheKey, value: null };
      return null;
    }
  }

  // Anthropic API mode: cost is computed locally from token usage × pricing
  // imported from @gryphon/provider-config.pricing.anthropic (derived from
  // the canonical registry). Prices may drift between Gryphon releases, and
  // cache discounts are estimated (we assume 5-min ephemeral cache: 1.25×
  // write, 0.10× read). UI labels SDK costs as "(est.)" so users know to
  // check console.anthropic.com for authoritative billing.
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

  async send(prompt: any, options: Record<string, any> = {}) {
    if (options && typeof options.maxUsdBudget === "number" && (!(options.maxUsdBudget > 0) || !isFinite(options.maxUsdBudget))) {
      throw new RangeError(`maxUsdBudget must be positive (got ${options.maxUsdBudget})`);
    }
    if (this.pending) {
      // Caller started a new turn before previous resolved — abort old.
      this.abort();
    }
    this.pending = true;
    // SDK analog of the CLI tainted-session fix: if the LAST turn ended
    // with a Gryphon protected deny, the model echoes the canonical
    // deny copy on the next turn without re-attempting the tool. Reset
    // history before the new user prompt so each retry shows the modal.
    // See openai-api.js for the full rationale. Chat-view UI bubbles
    // are unaffected; only the model's working memory is wiped.
    if (this._needsHistoryReset) {
      this.history.length = 0;
      this._needsHistoryReset = false;
    }

    // Snapshot the history length so we can roll back on error to the
    // state before this turn started — including any tool_use loop turns
    // the failure left half-applied.
    const historyCheckpoint = this.history.length;
    this.history.push({ role: "user", content: prompt });

    // Signal "init" so chat-view transitions from "Connecting" to "Thinking"
    if (this.onMessage) this.onMessage("", "init");

    const turnStart = Date.now();
    const ctx: Record<string, any> = {
      vaultRoot: this.cwd,
      permissionMode: this.options.permissionMode || "default",
      plugin: this.options.plugin || null,
      hostAdapter: this.hostAdapter,
    };
    // L5 per-call budget cap: thread maxUsdBudget and the per-call cost
    // helper into ctx so the tool-loop can check it mid-loop after each
    // model response. priorCumulativeCost is what has been spent before
    // this send() call so the loop can compute a per-call running total.
    ctx.maxUsdBudget = options && typeof options.maxUsdBudget === "number" ? options.maxUsdBudget : null;
    ctx.priorCumulativeCost = this.cumulativeCost;
    ctx.computeIterationCost = (usage: any) => computeCost(usage, this.resolvedModel);

    // L6 structured output: tool-use coercion. Declare a single forced tool
    // whose input_schema is the caller's schema. The model must call it — which
    // gives us grammar-constrained JSON output. The coercion tool is NOT
    // dispatched to Gryphon's tool registry; it is purely an output channel.
    if (options && options.structuredOutput) {
      ctx.coercionTool = {
        name: options.structuredOutput.name,
        description: "Return the structured response.",
        input_schema: options.structuredOutput.schema,
      };
      ctx.toolChoice = { type: "tool", name: options.structuredOutput.name };
    }

    try {
      const { turnText, finalMessage, totalUsage, peakUsage, thinkingBlocks } = await runToolLoop({
        client: this.client,
        model: this.resolvedModel,
        history: this.history,
        ctx,
        callbacks: {
          onMessage: (text: any, type: any) => {
            if (this.onMessage) this.onMessage(text, type);
          },
          onTool: (name: any) => {
            if (this.onMessage) this.onMessage(name, "tool");
          },
          onError: (text: any) => {
            if (this.onError) this.onError(text);
          },
          onStream: (stream: any) => {
            this.activeStream = stream;
          },
        },
      });

      this.activeStream = null;
      this.pending = false;

      // Post-turn taint check. Anthropic's tool_result blocks live
      // inside user-role messages as content array entries (not as
      // a separate role like OpenAI's "tool"). Walk the new slice
      // and look for the canonical Gryphon deny marker in any
      // tool_result block.
      const _GRYPHON_DENY_MARKER = "matches one of your protected patterns in Gryphon";
      const turnSlice = this.history.slice(historyCheckpoint);
      const hadProtectedDeny = turnSlice.some((m: any) => {
        if (!m || m.role !== "user" || !Array.isArray(m.content)) return false;
        return m.content.some((blk: any) => {
          if (!blk || blk.type !== "tool_result") return false;
          const c = blk.content;
          if (typeof c === "string") return c.includes(_GRYPHON_DENY_MARKER);
          if (Array.isArray(c)) {
            return c.some((sub) =>
              sub && typeof sub.text === "string" && sub.text.includes(_GRYPHON_DENY_MARKER)
            );
          }
          return false;
        });
      });
      if (hadProtectedDeny) {
        this._needsHistoryReset = true;
      }

      const turnCost = computeCost(totalUsage, this.resolvedModel);
      this.cumulativeCost += turnCost;
      // Issue #31: contextTokens is the peak window occupancy (last
      // iteration's input snapshot), NOT the cumulative sum across
      // tool-use iterations. The sum overcounts the same growing history
      // by ~3–5× on a 5-iteration agentic turn and trips auto-compact
      // long before the real window is full. Cost stays cumulative —
      // every API call bills for the full input it sent.
      const peak = peakUsage || totalUsage;
      this.contextTokens =
        (peak.input_tokens || 0) +
        (peak.cache_creation_input_tokens || 0) +
        (peak.cache_read_input_tokens || 0);

      // Prefer streaming-accumulated text (turnText). If the API ever
      // returns a response that produced no text deltas in-flight but
      // still carries text-like content in its block list — e.g. future
      // block types we don't yet unpack in the streaming handler —
      // _extractText sweeps every block that has a `.text` field so the
      // UI shows something rather than a blank "(No response)".
      const extracted = this._extractText(finalMessage && finalMessage.content);
      const result: Record<string, any> = {
        text: turnText || extracted,
        cost: turnCost,
        cumulativeCost: this.cumulativeCost,
        sessionId: this.sessionId,
        duration: Date.now() - turnStart,
        contextTokens: this.contextTokens,
        thinking: Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0
          ? thinkingBlocks : undefined,
      };

      // L6 structured output: extract coercion tool_use block's input.
      // When ctx.coercionTool is set, the loop skips dispatch on the
      // matching tool_use block (it is purely an output channel). The
      // block's `input` is already-parsed JSON — assign it to result.json
      // and serialize result.text for consumer consistency.
      if (ctx.coercionTool && finalMessage && Array.isArray(finalMessage.content)) {
        const coercionBlock = finalMessage.content.find(
          (b: any) => b && b.type === "tool_use" && b.name === ctx.coercionTool.name,
        );
        if (coercionBlock) {
          result.json = coercionBlock.input;
          result.text = JSON.stringify(coercionBlock.input);
        } else {
          // The model was forced via tool_choice but returned stop_reason
          // without invoking the coercion tool — surface a clear error so
          // callers get an actionable code rather than result.json === undefined.
          const err: any = new Error(
            `structuredOutput: Anthropic returned stop_reason "${finalMessage.stop_reason}" ` +
            `without invoking the forced "${ctx.coercionTool.name}" tool — coercion failed.`,
          );
          err.code = "STRUCTURED_OUTPUT_COERCION_FAILED";
          throw err;
        }
      }

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

  _extractText(content: any) {
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

  _formatError(err: any) {
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
async function testApiKey(apiKey: any) {
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
      return { ok: false, message: `API error (${(err as any).status || "?"}): ${(err as Error).message}` };
    }
    return { ok: false, message: String((err as Error)?.message || err) };
  }
}

export { AnthropicAPIProvider, testApiKey, resolveModel };