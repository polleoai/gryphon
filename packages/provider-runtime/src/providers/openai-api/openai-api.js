/**
 * OpenAIProvider — implements the LLMProvider contract via the official
 * `openai` npm SDK.
 *
 * Stage 2 — first hand-built non-Anthropic adapter. Mirrors the structure
 * of AnthropicAPIProvider deliberately so the chat-view doesn't need
 * provider-specific branches (it already routes by sessionId/resolvedModel).
 *
 * The OpenAI Chat Completions API is stateless, so this provider keeps the
 * full message history client-side and replays it on every turn. Streaming
 * uses `client.chat.completions.stream(...)` which emits `content` deltas
 * with cumulative snapshots — the provider forwards each snapshot through
 * onMessage(text, "replace").
 *
 * Tool support lives in `tool-loop.js` (Stage 2d). The provider's `send`
 * delegates to `runOpenAIToolLoop`, which speaks OpenAI's tool-call shape
 * but re-uses Gryphon's existing tool registry (the registry returns
 * Anthropic-format SCHEMAs; `tool-schema-translator.js` adapts them at the
 * adapter boundary). Tool execution itself goes through the shared
 * `executeTool(...)` from anthropic-api/tools/tool-registry — that path
 * already enforces the protected-pattern guardrails (attack-detector +
 * permission-gate), so the security posture is identical regardless of
 * which provider drives the loop.
 *
 * Cost calculation: SDK reports prompt_tokens / completion_tokens /
 * prompt_tokens_details.cached_tokens; pricing.js computeCost() converts
 * to USD. Cached tokens are billed at full input rate per the v1.2 design
 * decision (track-but-don't-discount until OpenAI's pricing stabilizes).
 */

const OpenAI = require("openai");
const { runOpenAIToolLoop } = require("./tool-loop");
const { resolveModel, coerceToVendorModel, computeCost, DEFAULT_MODEL } = require("@gryphon/provider-config").pricing.openai;

const { GRYPHON_SDK_COMPOUND_REQUEST_RULE } = require("@gryphon/protect");
const GRYPHON_OPENAI_SYSTEM_PROMPT_BASE =
  "You are running inside the Gryphon Obsidian plugin. The user's " +
  "own protected-pattern list inside Gryphon decides which file " +
  "paths and shell commands require approval or are refused. " +
  "· When a tool returns a refusal with a `reason` field, output " +
  "ONLY that reason to the user — no preamble before it (no " +
  "\"Tool execution blocked:\", no \"Error:\", no \"The Gryphon hook\", " +
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

// Append the shared compound-request rule. See anthropic-api/tool-loop.js
// for the rationale — the SDK model otherwise drops one half of a
// compound prompt silently.
const GRYPHON_OPENAI_SYSTEM_PROMPT =
  GRYPHON_OPENAI_SYSTEM_PROMPT_BASE + GRYPHON_SDK_COMPOUND_REQUEST_RULE;

class OpenAIProvider {
  constructor(apiKey, cwd, options = {}) {
    if (!apiKey) {
      throw new Error("OpenAIProvider: apiKey is required");
    }
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.options = options;

    // dangerouslyAllowBrowser: same justification as anthropic-api — Obsidian
    // exposes `window`, the SDK gates browser usage by default to prevent
    // API-key leakage in shipped client apps. Gryphon ships the key only
    // through plugin settings on the user's own disk, never to a third party.
    this.client = options.client || new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true,
      maxRetries: 3,
    });

    // Seed history from caller (defensive copy). OpenAI's message shape:
    //   { role: "system" | "user" | "assistant" | "tool", content, tool_calls?, tool_call_id? }
    this.history = Array.isArray(options.initialHistory)
      ? options.initialHistory.map((m) => cloneOpenAIMessage(m))
      : [];

    this.sessionId = `openai-sdk-${Date.now()}`;  // synthetic — SDK is stateless
    // coerceToVendorModel rejects cross-vendor leak (e.g. settings.model
    // carrying "gemini-2.5-flash" from prior Google use without a Settings →
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

  // OpenAI mode: cost is computed locally from token usage × MODEL_PRICES.
  // The price table may drift from OpenAI's published pricing between
  // Gryphon releases, and cached-token discounts are deliberately NOT
  // applied (per v1.2 design decision). UI labels OpenAI costs as "(est.)"
  // so users know to check platform.openai.com/usage for authoritative billing.
  get costIsEstimate() { return true; }

  abort() {
    if (this.activeStream) {
      try { this.activeStream.abort(); } catch {}
      this.activeStream = null;
    }
    this.pending = false;
    this.destroyed = true;
  }

  /**
   * **Concurrency invariant** (BT-6 Round 18): callers MUST serialize
   * `send()` invocations against the SAME provider instance. The chat-view
   * does this via the `isStreaming` enqueue gate (chat-view.js:3653 —
   * pending prompts queue while a turn is in flight). Without that gate,
   * a second `send()` while the first is awaiting would clobber `pending`,
   * `activeStream`, and most catastrophically `historyCheckpoint` — the
   * second send's user message could be truncated by the first send's
   * error rollback. This pattern is inherited from anthropic-api; the
   * fix path (if needed) is to convert the in-flight tracking to a queue
   * so the `pending` reset only fires for the matching turn.
   */
  async send(prompt) {
    if (this.pending) {
      this.abort();
    }
    this.pending = true;

    // SDK analog of the CLI tainted-session fix: if the LAST turn ended
    // with a Gryphon protected deny, the model's next call sees the
    // deny outcome in history and frequently echoes the canonical deny
    // copy without re-attempting the tool — exactly mirrors the
    // CLI session-resume bug. Reset the history before the new user
    // message so the model gets a fresh attempt and Gryphon's gate
    // fires on every retry. Chat-view UI bubbles are preserved
    // separately; only the model's working memory is wiped.
    // User report 2026-05-04 (Windows VM, openai-api mode).
    if (this._needsHistoryReset) {
      this.history.length = 0;
      this._needsHistoryReset = false;
    }

    // Snapshot for rollback on error (mirror anthropic-api semantics).
    const historyCheckpoint = this.history.length;
    this.history.push({ role: "user", content: prompt });

    if (this.onMessage) this.onMessage("", "init");

    const turnStart = Date.now();
    const ctx = {
      vaultRoot: this.cwd,
      permissionMode: this.options.permissionMode || "default",
      plugin: this.options.plugin || null,
    };

    try {
      const { turnText, finalMessage, totalUsage, peakUsage } = await runOpenAIToolLoop({
        client: this.client,
        model: this.resolvedModel,
        systemPrompt: GRYPHON_OPENAI_SYSTEM_PROMPT,
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

      // After-turn check: did this turn produce a Gryphon protected
      // deny? Scan the new history slice for a tool result whose
      // content matches the canonical deny marker. If so, mark the
      // session for reset on the next send. We sniff content rather
      // than wire a callback through the tool loop because (a) the
      // canonical text is a stable contract enforced by
      // permission-gate.js + plugin.js, (b) it keeps the cross-cutting
      // concern (taint propagation) localized to the SDK provider.
      const _GRYPHON_DENY_MARKER = "matches one of your protected patterns in Gryphon";
      const turnSlice = this.history.slice(historyCheckpoint);
      const hadProtectedDeny = turnSlice.some((m) =>
        m && m.role === "tool" && typeof m.content === "string" &&
        m.content.includes(_GRYPHON_DENY_MARKER)
      );
      if (hadProtectedDeny) {
        this._needsHistoryReset = true;
      }

      const { cost: turnCost } = computeCost(totalUsage, this.resolvedModel);
      this.cumulativeCost += turnCost;
      // Issue #31: contextTokens uses the LAST iteration's prompt_tokens
      // (peak window occupancy), not the cumulative sum. Each iteration's
      // prompt_tokens already includes the full chat history at that
      // call, so summing across iterations counts the same growing
      // context multiple times and trips auto-compact too early.
      const peak = peakUsage || totalUsage;
      this.contextTokens = (peak && peak.prompt_tokens) || 0;

      const result = {
        text: turnText || (finalMessage && finalMessage.content) || "",
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
    // Use the SDK's exported error classes via instanceof when available —
    // robust to minified production builds and class-name churn. Fall back
    // to `constructor.name` string match (which remains correct for the
    // mock-error path in tests, where the test creates its own
    // AuthenticationError class). Below-threshold finding BT-3 (Round 18).
    const looksLikeAuth =
      (OpenAI && OpenAI.AuthenticationError && err instanceof OpenAI.AuthenticationError) ||
      (err && err.constructor && err.constructor.name === "AuthenticationError");
    if (looksLikeAuth) {
      return "Invalid API key. Check Settings → Gryphon → OpenAI API key.";
    }
    const looksLikeRateLimit =
      (OpenAI && OpenAI.RateLimitError && err instanceof OpenAI.RateLimitError) ||
      (err && err.constructor && err.constructor.name === "RateLimitError");
    if (looksLikeRateLimit) {
      const retryAfter = err.headers && err.headers["retry-after"];
      const hint = retryAfter
        ? `Retry-After header says ${retryAfter} seconds.`
        : "Check your OpenAI usage dashboard for current rate limits.";
      return `Rate limited by OpenAI after 3 automatic retries. ${hint}`;
    }
    if (err && err.status) {
      return `OpenAI API error (${err.status}): ${err.message || String(err)}`;
    }
    return String((err && err.message) || err);
  }
}

function cloneOpenAIMessage(m) {
  const copy = { role: m.role, content: m.content };
  if (m.tool_calls) copy.tool_calls = JSON.parse(JSON.stringify(m.tool_calls));
  if (m.tool_call_id) copy.tool_call_id = m.tool_call_id;
  if (m.name) copy.name = m.name;
  return copy;
}

/**
 * Validate an API key by making a trivial chat.completions call.
 * Used by the "Test key" button in settings.
 */
async function testApiKey(apiKey) {
  if (!apiKey) return { ok: false, message: "No API key provided" };
  try {
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true, message: "Key works" };
  } catch (err) {
    const looksLikeAuth =
      (OpenAI && OpenAI.AuthenticationError && err instanceof OpenAI.AuthenticationError) ||
      (err && err.constructor && err.constructor.name === "AuthenticationError");
    if (looksLikeAuth) {
      return { ok: false, message: "Invalid API key" };
    }
    if (err && err.status) {
      return { ok: false, message: `API error (${err.status}): ${err.message}` };
    }
    return { ok: false, message: String((err && err.message) || err) };
  }
}

module.exports = { OpenAIProvider, testApiKey, resolveModel, DEFAULT_MODEL };
