/**
 * GryphonChatView — core chat ItemView used by Gryphon standalone and by
 * consuming plugins that compose Gryphon's chat surface.
 *
 * Responsibilities:
 *   - Render the chat UI (toolbar, messages, status bar, input, autocomplete)
 *   - Stream responses from the active LLM provider (CLI or SDK)
 *   - Persist and restore chat history (merges local log + CLI .jsonl)
 *   - Handle plugin-level slash commands (see SLASH_COMMANDS in constants.js
 *     for the authoritative inventory) and forward everything else to the
 *     provider for its own slash-command processing
 *
 * Extension points (passed via constructor `options`):
 *   - extraToolStatus      — entries merged into the tool→status map for
 *                            custom MCP tools
 *   - extraProcessArgs     — CLI args appended to every CLI provider spawn.
 *                            Cross-provider flags are filtered (issue #39):
 *                            a Claude-only flag like --disable-slash-commands
 *                            is silently dropped before the codex-cli or
 *                            gemini-cli spawn so the spawn doesn't fail with
 *                            "unknown argument."
 *   - extraProcessArgsByProvider — { 'claude-code': [...], 'codex-cli': [...],
 *                            'gemini-cli': [...], ... } — per-provider
 *                            extra CLI args. Skips the cross-provider
 *                            filter (entries are already targeted). Use
 *                            this for clean per-provider routing instead
 *                            of relying on the filter.
 *   - onBeforeSend         — callback(text) => boolean. Return true to
 *                            "consume" a message (intercept domain-specific
 *                            commands before they reach the provider).
 *   - autocompleteSources  — array of { name, matches(text), suggest(text) }.
 *                            Core prepends a built-in slash source; consumer
 *                            sources extend it.
 *   - stopStreamingHooks   — array of hook(view) callbacks run BEFORE core
 *                            teardown in stopStreaming (for cleaning up
 *                            plugin-owned side processes).
 *   - viewType / displayText / icon — per-plugin view identity.
 *
 * This file knows nothing about any specific consuming plugin's domain.
 * All coupling comes through the options bag; consumers wire their own
 * behavior via autocompleteSources, stopStreamingHooks, onBeforeSend.
 */

const { ItemView, MarkdownRenderer, Menu, MarkdownView } = require("obsidian");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createProvider, explainUnavailable, detectAvailable } = require("@gryphon/provider-runtime");
const {
  TOOL_STATUS_CORE, MODELS, EFFORTS, PERMS, MODEL_CONTEXT, SLASH_COMMANDS,
  CC_BLOCKED_IN_STREAM_JSON,
  CONTEXT_WARN_PCT, CONTEXT_WARN_RESET_PCT, AUTO_COMPACT_SDK_THRESHOLD_PCT,
  resolveConnectionTimeoutMs,
} = require("./constants");

/**
 * Decide which messages survive a chat-history save. Pure function —
 * extracted from `_doSaveChatHistory` for direct unit testing.
 *
 * Invariant: LLM messages are suppressed ONLY when we're currently
 * in a CLI session AND the specific message was authored during that
 * session (CC's jsonl will re-supply it on load). All other messages
 * — non-LLM, from prior sessions, from SDK, from legacy untagged
 * data — always survive.
 *
 * @param {Array<object>} messages
 * @param {string|null} currentSessionId — value of plugin.settings.lastSessionId
 * @returns {Array<object>}
 */
// Provider session prefixes that indicate "the chat-view's saved
// messages are the canonical record." The CLI optimization in
// filterMessagesForSave drops llm messages tagged with the current
// session because Claude Code's stream-json re-supplies the history on
// --resume — but providers that DON'T do that re-supply rely on
// chat-history.json as the only message store, so dropping is data loss.
//
// Tagged via synthetic prefix:
//   - "sdk-..."          → anthropic-api SDK (legacy)
//   - "openai-sdk-..."   → openai-api SDK
//   - "gemini-sdk-..."   → google-api SDK
//   - "codex-cli-..."    → codex-cli   (one-shot CLI; no resume re-supply)
//   - "gemini-cli-..."   → gemini-cli  (one-shot CLI; no resume re-supply)
//
// Anything else (typically a UUID) is treated as a Claude-Code-style CLI
// session whose history will be re-supplied on resume.
const _SDK_SESSION_PREFIX_RE = /^(sdk|openai-sdk|gemini-sdk|codex-cli|gemini-cli)-/;

/**
 * Insert a paragraph break before any canonical Gryphon-emitted block
 * that lands on the same line as the model's prior text. The model
 * commonly emits a narration sentence ("I will now attempt to remove
 * the file."), then a tool call, then echoes our canonical deny copy
 * back to the user — and depending on how each provider's tool loop
 * accumulates text (`+=`), the two segments smush together with no
 * separator: `"...remove the file.This operation matches..."`.
 *
 * This normalizer runs once per "replace" stream event, so every
 * provider (CLI: claude-code / codex-cli / gemini-cli; SDK:
 * anthropic-api / openai-api / google-api) gets the same treatment in
 * one place. The patterns matched are STABLE Gryphon-emitted strings
 * (canonical deny copy and refusal preambles) — not arbitrary user
 * content. We only inject a break when:
 *   - the marker isn't at the start of the text, AND
 *   - the character immediately before the marker isn't whitespace.
 * That guarantees idempotence and avoids mangling cases where the
 * upstream accumulator already inserted a separator correctly.
 */
const _CANONICAL_BLOCK_MARKERS = [
  // Current canonical opening (2026-05-04). See providers/shared/deny-copy.js.
  "The Gryphon plugin is blocking the ",
  // Legacy canonical opening — still recognised so persisted history
  // from earlier builds still gets paragraph-separated correctly when
  // re-rendered. New emissions never produce this prefix.
  "This operation matches one of your protected patterns in Gryphon",
  "You declined ",
  "User declined ",
  "User previously denied ",
];

/**
 * Forbidden preambles that have been observed directly preceding a
 * canonical Gryphon deny marker. The model is supposed to quote the
 * deny reason verbatim with NOTHING before it; in practice some
 * models add a wrapper like "Tool execution blocked: " or "Error: "
 * relayed from the underlying CLI's tool-error envelope. Strip these
 * when they appear immediately before a canonical marker (on the
 * same line, no other content between).
 *
 * Add to this list when a new variant surfaces in the wild. Keep
 * entries SPECIFIC (full phrase + trailing colon-space) so we don't
 * accidentally strip legitimate prose that happens to contain one
 * of these words.
 */
const _FORBIDDEN_PREAMBLES_BEFORE_MARKER = [
  "Tool execution blocked: ",                          // Gemini CLI tool-error envelope
  "Error: ",                                           // Gemini SDK older shape, generic relay
  // NOTE: "The Gryphon plugin is blocking this..." used to be
  // forbidden; as of 2026-05-04 the canonical opening IS
  // "The Gryphon plugin is blocking the {description}..." so we no
  // longer strip that prefix. The strip-list now only covers
  // wrappers added BY THE CLI/SDK (tool-error envelopes) ahead of
  // the canonical, not paraphrases that overlap with the canonical.
];

/**
 * Collapse consecutive identical paragraphs in streamed assistant
 * text. Sometimes a model (notably Gemini-2.5 via the CLI on macOS)
 * emits the same paragraph twice in a row before a tool call —
 * either via the SDK delivering both a delta and a non-delta event
 * with the same content, or via the model genuinely regenerating
 * its first paragraph. The result in chat is two indistinguishable
 * paragraphs back-to-back. This dedupes them at the rendering
 * boundary so it can't leak to the bubble regardless of which
 * provider produces it.
 *
 * Conservative: only collapses paragraphs that are byte-for-byte
 * identical AND non-trivial (≥40 chars, so common short headings
 * or list items aren't merged accidentally). Multi-paragraph
 * sequences with different content pass through unchanged.
 */
function _dedupeConsecutiveParagraphs(text) {
  if (typeof text !== "string" || text.length === 0) return text;

  // Normalize line endings up front. Gemini CLI on Windows can emit
  // `\r\n` in its stream-json output; without this normalization the
  // `\n`-only regexes below treat `\r` as a non-newline character
  // and the duplicate-collapse misses entirely. User report
  // 2026-05-04 (Windows Gemini CLI 2.5 flash, after the inline-newline
  // fix shipped — the test on a `\n`-normalized fixture passed but
  // the VM still showed duplicates because its source had `\r\n`).
  let dedup = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // First pass: collapse adjacent identical LONG runs separated by
  // ZERO OR MORE whitespace characters. Three shapes observed in the
  // wild from various provider accumulators (counterfeit-newline
  // approximations of paragraph breaks):
  //   - "S1.\nS1." — single newline (most common)
  //   - "S1.\n\nS1." — paragraph break
  //   - "S1.S1." — NO separator at all (Gemini CLI 2.5 flash on
  //     Windows occasionally streams this — period directly butts
  //     against the next sentence). User report 2026-05-04.
  // The 40-char minimum keeps this from over-collapsing legitimate
  // short repetitions ("Yes\nYes", list bullets, headings). Loop
  // until stable so 3+ in-a-row collapses fully — each pass
  // removes one duplicate at a time.
  let previous;
  do {
    previous = dedup;
    dedup = dedup.replace(
      /([^\n]{40,})\s*\1(?=\s|[.!?,]|$)/g,
      "$1",
    );
  } while (dedup !== previous);

  // Second pass: paragraph-level dedupe with a permissive splitter
  // that tolerates whitespace-only "blank" lines (a `\n \n` shape
  // we've seen in the wild from line-by-line accumulators that
  // emit single-space buffer flushes between paragraphs).
  const paragraphs = dedup.split(/\n[ \t]*\n+/);
  if (paragraphs.length < 2) return dedup;
  const out = [];
  for (const p of paragraphs) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev === p && p.length >= 40) continue;
    out.push(p);
  }
  return out.join("\n\n");
}

/**
 * Collapse "draft" summaries into a <details> disclosure when the
 * model regenerates its answer on a refused turn. Pattern observed on
 * Gemini 2.5 (CLI + flash-lite especially): the model emits one
 * summary, calls a tool, the tool gets refused, and on its next pass
 * it emits ANOTHER refined summary covering the same topic before
 * quoting the deny copy. Result is two summary paragraphs of similar
 * content + the canonical deny — visually noisy.
 *
 * This routine identifies "draft groups" — consecutive paragraphs
 * BEFORE the canonical deny block that share enough vocabulary to be
 * the same answer iterated — and wraps the earlier ones in a
 * collapsed `<details>` element. The latest version stays the
 * primary visible content. Same UX pattern Claude Code's thinking
 * blocks use: secondary content present but click-to-expand.
 *
 * Safety nets:
 *   1. Only fires when a canonical deny marker is in the text.
 *      Without a refusal, multi-paragraph responses are legitimate
 *      content — never collapse normal answers.
 *   2. Both paragraphs must be ≥80 chars (real summaries, not
 *      fragments / headings / bullets).
 *   3. Jaccard similarity on word-stems ≥0.5 — high enough to require
 *      genuine topic overlap, not coincidental keyword reuse.
 */
function _wordSetForSimilarity(text) {
  // Lowercased, length-filtered word set. 4-char minimum keeps
  // common short words (the, and, of, to) out of the comparison.
  const matches = text.toLowerCase().match(/\b[a-z]{4,}\b/g);
  return matches ? new Set(matches) : new Set();
}

function _jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function _collapseSummaryDrafts(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length < 3) return text;  // need draft + final + deny

  // Find the canonical deny marker. If absent, do nothing — outside
  // of refused-turn scenarios we leave multi-paragraph responses
  // alone.
  let denyIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    for (const marker of _CANONICAL_BLOCK_MARKERS) {
      if (paragraphs[i].includes(marker)) { denyIdx = i; break; }
    }
    if (denyIdx >= 0) break;
  }
  if (denyIdx < 1) return text;  // <0: no deny; ==0: deny is first, no drafts to collapse

  const before = paragraphs.slice(0, denyIdx);
  const after = paragraphs.slice(denyIdx);
  if (before.length < 2) return text;

  // Group consecutive paragraphs by topic similarity. A "group" is a
  // run of paragraphs where each adjacent pair has Jaccard ≥0.5 AND
  // both are ≥80 chars (substantive summaries, not bullets).
  const groups = [[before[0]]];
  for (let i = 1; i < before.length; i++) {
    const cur = before[i];
    const prevGroup = groups[groups.length - 1];
    const prev = prevGroup[prevGroup.length - 1];
    const sim = _jaccardSimilarity(_wordSetForSimilarity(prev), _wordSetForSimilarity(cur));
    if (sim >= 0.5 && cur.length >= 80 && prev.length >= 80) {
      prevGroup.push(cur);
    } else {
      groups.push([cur]);
    }
  }

  const out = [];
  for (const group of groups) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // Multi-paragraph group: keep the last as canonical, collapse
    // earlier into a <details> disclosure. Markdown renderers
    // (Obsidian's included) honor raw <details> tags.
    const drafts = group.slice(0, -1);
    const finalP = group[group.length - 1];
    const summaryLabel = drafts.length > 1 ? "Earlier drafts" : "Earlier draft";
    out.push(
      `<details class="gryphon-draft-fold"><summary>${summaryLabel}</summary>\n\n` +
      drafts.join("\n\n") +
      `\n\n</details>`
    );
    out.push(finalP);
  }
  return out.concat(after).join("\n\n");
}

function _separateCanonicalBlocks(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;

  // First pass: strip forbidden preambles that immediately precede a
  // canonical deny marker. These are wrappers some models add when
  // relaying the deny — "Tool execution blocked: ", "Error: ", etc.
  // Stripping them at the rendering boundary keeps the deny copy
  // verbatim regardless of which provider's relay shape is used.
  // We loop until stable so multi-marker cases (rare but possible
  // if a single bubble carries two denied operations) are all
  // cleaned up.
  let prev;
  do {
    prev = out;
    for (const marker of _CANONICAL_BLOCK_MARKERS) {
      for (const preamble of _FORBIDDEN_PREAMBLES_BEFORE_MARKER) {
        const combined = preamble + marker;
        const idx = out.indexOf(combined);
        if (idx === -1) continue;
        // Strip the preamble — keep the marker.
        out = out.slice(0, idx) + out.slice(idx + preamble.length);
      }
    }
  } while (out !== prev);

  // Second pass: paragraph-separate the canonical marker from any
  // preceding model narration.
  for (const marker of _CANONICAL_BLOCK_MARKERS) {
    let from = 0;
    while (from < out.length) {
      const idx = out.indexOf(marker, from);
      if (idx === -1) break;
      // Idempotent: skip if already separated, or if the marker is at
      // the very start of the text.
      if (idx === 0) { from = idx + marker.length; continue; }
      const prevChar = out[idx - 1];
      if (prevChar === "\n" || prevChar === " " || prevChar === "\t") {
        // Already separated by some whitespace — only inject if it's
        // a single non-paragraph space (e.g. ". This operation..."
        // should become ".\n\nThis operation..."). Specifically: if
        // the prior char is a space and the char two-back is a
        // sentence terminator (.!?), this is a smushed paragraph
        // boundary.
        if (prevChar === " " && idx >= 2 && /[.!?]/.test(out[idx - 2])) {
          out = out.slice(0, idx - 1) + "\n\n" + out.slice(idx);
          from = idx - 1 + 2 + marker.length;
        } else {
          from = idx + marker.length;
        }
      } else {
        // No whitespace at all — direct smush. Inject paragraph break.
        out = out.slice(0, idx) + "\n\n" + out.slice(idx);
        from = idx + 2 + marker.length;
      }
    }
  }
  return out;
}

/**
 * Issue #29: short brand-y label used in the provider-change status
 * notice ("will continue with Gemini"). Different from PROVIDER_PREFS's
 * `label` field — that one carries qualifier suffixes ("(recommended)",
 * "(advanced)") which clutter a one-line status bar string.
 */
/**
 * Issue #34: classify a thrown send() error as a rate-limit / quota
 * error so the chat-view can preserve the user's prompt for retry.
 *
 * Covers wire shapes from all four SDK providers + the two CLI providers:
 *   - HTTP 429 status (status / statusCode property, or "429" in message)
 *   - "Too Many Requests" / "rate limited" / "rate-limit" / "rate_limit"
 *   - Gemini's "RESOURCE_EXHAUSTED" + quota markers
 *   - "Please retry in <Xs>" copy from Gemini's friendly formatter
 *
 * Conservative — false negatives (missing a real rate-limit) just
 * preserve the existing behavior (user re-types). False positives
 * (treating a non-rate-limit error as one) only cost a prompt restore,
 * which is harmless for the user.
 */
function _isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || (err.error && err.error.status);
  if (status === 429) return true;
  const msg = String(err.message || err);
  if (!msg) return false;
  return /\b429\b|Too Many Requests|rate[\s\-_]?limit(?:ed)?|RESOURCE_EXHAUSTED|[Pp]lease retry in|quota[ _]?(?:exceeded|exhausted)/i.test(msg);
}

/**
 * Issue #34 deferred: extract the retry-after delay (in seconds) from a
 * rate-limit error so the auto-retry path can schedule a precise
 * resubmit instead of guessing. Returns null when no delay is parseable
 * — the caller should NOT auto-retry without a value (avoids tight
 * loops against unknown-cooldown rate limits).
 *
 * Recognized shapes:
 *   - `Retry-After` header (seconds OR HTTP-date) on err.headers / err.response.headers
 *   - "Please retry in 12.3s" / "retry in 500ms" copy in the error body
 *   - SDK-specific `retryAfterSeconds` / `retry_after` fields
 *
 * Capped at 60s — a per-day Gemini quota reports values like 86400s,
 * and queueing a 24h auto-retry is a footgun (background tab, cost,
 * staleness). Anything longer than 60 returns null so the user
 * deliberately decides whether to re-press Send later.
 */
function _parseRetryAfterSeconds(err) {
  if (!err) return null;
  const tooLong = (s) => s == null || !isFinite(s) || s <= 0 || s > 60;
  // Direct fields some SDKs expose.
  if (typeof err.retryAfterSeconds === "number" && !tooLong(err.retryAfterSeconds)) {
    return err.retryAfterSeconds;
  }
  if (typeof err.retry_after === "number" && !tooLong(err.retry_after)) {
    return err.retry_after;
  }
  // HTTP Retry-After header — fetch shape (`err.headers.get`) or plain object.
  const headers =
    (err.headers && (typeof err.headers.get === "function"
      ? { "retry-after": err.headers.get("retry-after") }
      : err.headers)) ||
    (err.response && err.response.headers) ||
    null;
  if (headers) {
    const raw = headers["retry-after"] || headers["Retry-After"];
    if (raw) {
      const n = Number(raw);
      if (!tooLong(n)) return n;
      // HTTP-date variant: parse and convert delta to seconds.
      const t = Date.parse(raw);
      if (isFinite(t)) {
        const delta = (t - Date.now()) / 1000;
        if (!tooLong(delta)) return Math.ceil(delta);
      }
    }
  }
  // "Please retry in 12.3s" / "retry in 500ms" body parse.
  const msg = String(err.message || err || "");
  const m = msg.match(/\b[Pp]lease retry in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/);
  if (m) {
    const v = parseFloat(m[1]);
    const seconds = m[2] === "ms" ? v / 1000 : v;
    if (!tooLong(seconds)) return seconds;
  }
  return null;
}

/**
 * Claude Code emits the synthetic placeholder `"No response requested."`
 * as the assistant text whenever a turn ends without a real text response
 * — e.g. tool-only turns, pass-through interpretations of short ambiguous
 * prompts ("continue"), or aborts mid-stream. The string comes from CC's
 * own `NO_RESPONSE_REQUESTED` constant (cc/src/utils/messages.ts), where
 * it lives in a `SYNTHETIC_MESSAGES` set that the CLI treats as "not real
 * content." Rendering it verbatim in the user's chat reads as a bewildering
 * non-sequitur ("I asked the model something, it said 'No response
 * requested'") — so we replace it with copy that names what actually
 * happened and points at recovery actions.
 *
 * The match is exact to the CC constant; near-matches ("No response
 * required", model-paraphrased variants) are LEFT ALONE — they could be
 * legitimate model output. Same idempotent on already-clean text.
 */
const _CC_NO_RESPONSE_REQUESTED = "No response requested.";

function _replaceNoResponsePlaceholder(text) {
  if (typeof text !== "string") return text;
  // Allow leading/trailing whitespace but no other surrounding content —
  // the placeholder always arrives as the entire assistant text, never
  // embedded in a longer reply.
  if (text.trim() !== _CC_NO_RESPONSE_REQUESTED) return text;
  return (
    "_(The model returned no text response — this often happens on tool-only " +
    "turns, very short prompts, or aborted streams. Try a more specific " +
    "prompt, or run `/context` to inspect session state.)_"
  );
}

function _providerLabelFor(preference) {
  switch (preference) {
    case "anthropic-api":  return "Anthropic API";
    case "claude-code":    return "Claude Code CLI";
    case "openai-api":     return "OpenAI API";
    case "google-api":     return "Google Gemini API";
    case "codex-cli":      return "Codex CLI";
    case "gemini-cli":     return "Gemini CLI";
    case "auto":           return "Auto-selected provider";
    default:               return preference || "the new provider";
  }
}

function filterMessagesForSave(messages, currentSessionId) {
  const currentId = currentSessionId || null;
  // Issue #36: aborted/errored user prompts must always survive the
  // save filter, even when their sessionId matches the current CLI
  // session. The session-id-keyed drop assumes the CLI's jsonl has a
  // copy — but for prompts whose response failed (timeout, rate-limit,
  // network error), the CLI may never have received the prompt, so
  // dropping leaves NO copy anywhere and up-arrow recall loses the
  // user's typed text after reload. The `failed` flag is set in
  // sendMessage's catch block; handled below.
  // Bug #24 fix: detect SDK sessions across all three providers, not just
  // the legacy anthropic-api "sdk-" prefix. Before the fix, OpenAI / Gemini
  // session ids ("openai-sdk-...", "gemini-sdk-...") didn't match the
  // legacy check, so currentIsCli evaluated TRUE and the filter dropped
  // every llm message tagged with the current SDK session — silent
  // user-data loss whenever a save fired with the matching lastSessionId.
  const currentIsCli = !!(currentId && !_SDK_SESSION_PREFIX_RE.test(String(currentId)));
  return (messages || []).filter((m) => {
    if (!m || !m.source) return false;
    if (m.source !== "llm") return true;
    if (!currentIsCli) return true;
    // Issue #36: aborted/errored user prompts always survive — they
    // may not be in the CLI's jsonl (the prompt failed to land), and
    // the existing save-drop assumption breaks for that case.
    if (m.failed === true) return true;
    return m.sessionId !== currentId;
  });
}

/**
 * Pure-function context-window pct for unit testing. Mirrors the
 * arithmetic in `_currentContextPct` so the boundary math (0, 80, 95,
 * 100) can be asserted without a DOM.
 *
 * @param {number} tokens
 * @param {number} windowSize
 * @returns {number} integer 0..100
 */
function computeContextPct(tokens, windowSize) {
  if (!tokens || !windowSize || windowSize <= 0) return 0;
  return Math.min(100, Math.round(tokens / windowSize * 100));
}

/**
 * Pure-function decision: should we start an SDK auto-compact?
 *
 * @param {object} state
 *   pct           — current context %
 *   isSdk         — provider is SDK?
 *   autoCompactSdk — user setting (true = enabled)
 *   isCompacting  — already a compact in flight?
 *   messageCount  — messages.length (need >= 4 to summarize)
 *   lagFailsafe   — bypass pct threshold (catch-branch path)
 * @returns {boolean}
 */
function shouldStartAutoCompact({
  pct, isSdk, autoCompactSdk, isCompacting, messageCount, lagFailsafe,
}) {
  if (isCompacting) return false;
  if (!isSdk) return false;
  if (autoCompactSdk === false) return false;
  if (!lagFailsafe && (pct == null || pct < 95)) return false;
  if (!messageCount || messageCount < 4) return false;
  return true;
}

/**
 * Pure-function hysteresis decision for the 80% one-shot warning.
 * Encodes: fire once when crossing CONTEXT_WARN_PCT (and below
 * AUTO_COMPACT_SDK_THRESHOLD_PCT); reset only when dropping below
 * CONTEXT_WARN_RESET_PCT.
 *
 * @param {{shown: boolean}} prev
 * @param {number} pct
 * @returns {{shown: boolean, fire: boolean}}
 *   shown — new value of the "warning shown" flag
 *   fire  — whether to flash this turn
 */
function nextContextWarningState(prev, pct) {
  const shown = !!(prev && prev.shown);
  if (pct >= 80 && pct < 95 && !shown) return { shown: true,  fire: true  };
  if (pct < 75 && shown)               return { shown: false, fire: false };
  return { shown, fire: false };
}

function labelFor(list, value) {
  const item = list.find((x) => x.value === value);
  return item ? item.label : value;
}

/**
 * Toolbar model-button text. The ACTIVE provider (resolved with auto-
 * fallthrough — not just the literal `providerPreference`) gates which
 * model list applies:
 *   • claude-code / anthropic-api → Anthropic MODELS (Haiku / Sonnet / Opus)
 *   • openai-api → OpenAI model list (gpt-5 family + legacy 4o)
 *   • google-api → Stage-3-pending hint until the Gemini adapter ships (#18)
 *
 * The `plugin` argument is used to call factory.getActiveProviderKind so
 * Auto-mode users with only an OpenAI key see the OpenAI list (not the
 * Anthropic list). Tests that only have a settings object can pass it as
 * `plugin` directly — the helper just needs `.settings`.
 */
function modelButtonText(settingsOrPlugin) {
  const settings = settingsOrPlugin && settingsOrPlugin.settings
    ? settingsOrPlugin.settings : settingsOrPlugin;
  const plugin = settingsOrPlugin && settingsOrPlugin.settings
    ? settingsOrPlugin : { settings };
  const { getActiveProviderKind } = require("@gryphon/provider-runtime");
  const kind = getActiveProviderKind(plugin) || settings.providerPreference;

  if (kind === "openai-api" || kind === "codex-cli") {
    // codex-cli reuses OpenAI's pricing tables but its ChatGPT-account
    // auth path supports a smaller subset (gpt-5.5 / gpt-5.4 / gpt-5.4-
    // mini). API-only ids fall back to the codex-specific default.
    const {
      getModelDropdownOptions,
      getCodexCliModelDropdownOptions,
      resolveModel: resolveOpenAIModel,
      coerceToCodexCliModel,
      DEFAULT_MODEL: OPENAI_DEFAULT_MODEL,
      CODEX_CLI_DEFAULT_MODEL,
    } = require("@gryphon/provider-runtime").pricing.openai;
    const isCodex = kind === "codex-cli";
    const options = (isCodex ? getCodexCliModelDropdownOptions() : getModelDropdownOptions())
      .map((o) => ({ value: o.id, label: o.label }));
    const requested = settings && settings.model;
    // Defensive fallback when the persisted model id isn't a member of
    // the active dropdown (e.g. cross-vendor switch with `model="sonnet"`,
    // or an API-only id like `gpt-5-mini` while codex-cli is active):
    // mirror what the runtime resolver will pick so the toolbar label
    // matches the actual spawn (no UI/runtime gap; Round 18 F23-1).
    if (options.some((o) => o.value === requested)) {
      return labelFor(options, requested);
    }
    const resolver = isCodex ? coerceToCodexCliModel : resolveOpenAIModel;
    const resolved = resolver(requested);
    const fitsDropdown = options.some((o) => o.value === resolved);
    const fallback = isCodex ? CODEX_CLI_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
    return labelFor(options, fitsDropdown ? resolved : fallback);
  }
  if (kind === "google-api" || kind === "gemini-cli") {
    // gemini-cli reuses Google's pricing tables / model dropdown.
    const {
      getModelDropdownOptions: getGeminiOptions,
      resolveModel: resolveGeminiModel,
      DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
    } = require("@gryphon/provider-runtime").pricing.google;
    const options = getGeminiOptions().map((o) => ({ value: o.id, label: o.label }));
    const requested = settings && settings.model;
    if (options.some((o) => o.value === requested)) {
      return labelFor(options, requested);
    }
    const resolved = resolveGeminiModel(requested);
    const fitsDropdown = options.some((o) => o.value === resolved);
    return labelFor(options, fitsDropdown ? resolved : GEMINI_DEFAULT_MODEL);
  }
  // Anthropic / Claude Code: same fallback shape as the OpenAI branch — if
  // settings.model isn't in MODELS (e.g. user just switched FROM openai-api
  // and persisted "gpt-5.4-mini" carries over), use "sonnet" as the default
  // so the toolbar doesn't show a raw OpenAI id like "gpt-5.4-mini".
  const requested = settings && settings.model;
  if (MODELS.some((m) => m.value === requested)) {
    return labelFor(MODELS, requested);
  }
  return labelFor(MODELS, "sonnet");
}

function modelButtonTitle(settingsOrPlugin) {
  const settings = settingsOrPlugin && settingsOrPlugin.settings
    ? settingsOrPlugin.settings : settingsOrPlugin;
  const plugin = settingsOrPlugin && settingsOrPlugin.settings
    ? settingsOrPlugin : { settings };
  const { getActiveProviderKind } = require("@gryphon/provider-runtime");
  const kind = getActiveProviderKind(plugin) || settings.providerPreference;
  // Brand-only label — API and CLI variants share the same name so
  // the toolbar matches the approve/deny modal's "Codex / Gemini /
  // Claude" naming. Users care about the model family, not whether
  // it's reached via HTTPS or a local subprocess.
  if (kind === "openai-api" || kind === "codex-cli")  return "Model (Codex)";
  if (kind === "google-api" || kind === "gemini-cli") return "Model (Gemini)";
  if (kind === "anthropic-api" || kind === "claude-code") return "Model (Claude)";
  return "Model";
}

const CARET_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

class GryphonChatView extends ItemView {
  constructor(leaf, plugin, options = {}) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.isStreaming = false;
    this.streamingText = "";
    this.claudeProcess = null;
    this.cumulativeCost = 0;
    // One-shot flag set when the just-finalized assistant turn
    // contained the canonical Gryphon protected-deny marker. The
    // NEXT send injects a "post-deny clarifier" reminder block so
    // the model doesn't misread the next user message as a no-op
    // repeat / system notification. _consumePostDenyClarifier
    // clears this after firing.
    this._priorTurnHadProtectedDeny = false;
    // Issue #3: prompts the user submitted while a turn was streaming.
    // Each entry: { text: string, bubbleEl: HTMLElement }. Drained one at
    // a time after each turn finalizes. The bubbleEl is rendered with a
    // "queued" class so the user gets immediate feedback that the send
    // was accepted; on fire we remove it and let the normal send pipeline
    // re-render + persist the user message.
    this._queuedPrompts = [];
    // Parallel record of queued-but-not-yet-fired prompt texts. Used by
    // up-arrow recall (`_getPromptHistory`) and as the recovery source
    // when a turn aborts or times out — at cleanup we drop the DOM
    // bubbles but keep the texts here so the user can up-arrow back to
    // any queued message that didn't get a chance to fire.
    this._pendingQueuedTexts = [];

    // Extension points for consuming plugins — see file header for the
    // full contract.
    this.toolStatusMap = { ...TOOL_STATUS_CORE, ...(options.extraToolStatus || {}) };
    this.extraProcessArgs = options.extraProcessArgs || [];
    // Issue #39: per-provider extra CLI args. Each provider's adapter
    // receives only its own bucket merged with the legacy extraProcessArgs
    // (which is filtered for cross-provider compatibility).
    this.extraProcessArgsByProvider = options.extraProcessArgsByProvider || {};
    // Round 4 review (SFH-2): validate the keys at construction so a
    // typo like "claude_code" or "claudeCode" surfaces during the
    // consumer's integration test instead of silently no-op'ing every
    // spawn forever. One-shot O(n) check — n is at most 6.
    const KNOWN_PROVIDER_KINDS = [
      "claude-code", "anthropic-api", "openai-api", "google-api",
      "codex-cli", "gemini-cli",
    ];
    const knownSet = new Set(KNOWN_PROVIDER_KINDS);
    for (const key of Object.keys(this.extraProcessArgsByProvider)) {
      if (!knownSet.has(key)) {
        console.error(
          `[gryphon] extraProcessArgsByProvider has unknown provider key ` +
          `"${key}". Args under this key will be ignored. Valid keys: ` +
          `${KNOWN_PROVIDER_KINDS.join(", ")}.`,
        );
      }
    }
    this.onBeforeSend = options.onBeforeSend || null;
    this.viewType = options.viewType || "gryphon-view";
    this.viewDisplayText = options.displayText || "Gryphon";
    this.viewIcon = options.icon || "shield-check";

    // Autocomplete sources: each source is { name, matches(text), suggest(text) }.
    // `matches` returns true if this source should handle the input.
    // `suggest` returns {cmd, desc}[]. First source to match wins; core's
    // slash-command source is prepended so it always competes first.
    //
    // The slash source pulls from the plugin's SkillRegistry (if present)
    // so user-authored skills appear alongside built-ins. Falls back to
    // the static list when no registry is wired — keeps standalone tests
    // of the view simple.
    this.autocompleteSources = [
      {
        name: "slash",
        matches: (text) => text.startsWith("/"),
        suggest: (text) => {
          const source = (this.plugin && this.plugin.skillRegistry)
            ? this.plugin.skillRegistry.effectiveSlashCommands()
            : SLASH_COMMANDS;
          return source.filter((c) => c.cmd.toLowerCase().startsWith(text.toLowerCase()));
        },
      },
      ...(options.autocompleteSources || []),
    ];

    // Stop-streaming hooks: each is called with (this) before core teardown.
    // Lets consumers abort plugin-owned side processes (mechanical CLI
    // subprocesses, browser-capture windows, etc.).
    this.stopStreamingHooks = options.stopStreamingHooks || [];
  }

  getViewType() { return this.viewType; }
  getDisplayText() { return this.viewDisplayText; }
  getIcon() { return this.viewIcon; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("gryphon-container");

    // Messages area
    this.messagesEl = container.createDiv("gryphon-messages");

    // Handle clicks on internal links (wikilinks rendered by MarkdownRenderer)
    this.messagesEl.addEventListener("click", (e) => {
      const link = e.target.closest("a.internal-link");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("data-href") || link.getAttribute("href");
        if (href) {
          this.app.workspace.openLinkText(href, "");
        }
      }
    });

    // Restore previous conversation. The welcome hint lives in the status
    // bar (see _setIdleStatus) — no need to add a throwaway system bubble
    // on every open that the user would immediately scroll past.
    this._restoreChatHistory();

    // First-run / unconfigured-provider onboarding. Shows a guided setup
    // panel inside the message area when no provider is available;
    // returning users with a working provider see nothing extra.
    this._renderWelcomePanelIfNeeded();

    // Surface skill-loader errors as a one-line system message so users
    // notice when a skill failed to load — silent failure was the
    // pre-Phase-6 behavior and made debugging skill files painful.
    this._surfaceSkillLoadErrors();

    // Track the user's most recent non-empty selection anywhere in the
    // document. Captures both Source/Live-Preview editor selections
    // (CodeMirror → DOM → selectionchange) and Reading-mode DOM
    // selections (rendered HTML). This is what makes /selection work:
    // by the time the user types /selection into the chat input, the
    // browser has cleared the DOM selection, but we still have a cached
    // copy from before the focus change. `ignoreChat` prevents echoing
    // the user's own selection within the chat bubble area.
    this._cachedSelection = null;
    this.registerDomEvent(document, "selectionchange", () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      if (!text) return;
      // Skip selections inside the Gryphon view itself (chat bubbles).
      try {
        const node = sel.anchorNode;
        const inChat = node && node.nodeType === Node.ELEMENT_NODE
          ? node.closest && node.closest(".gryphon-container")
          : node && node.parentElement && node.parentElement.closest(".gryphon-container");
        if (inChat) return;
      } catch {}
      this._cachedSelection = {
        text,
        file: this.app.workspace.getActiveFile(),
        capturedAt: Date.now(),
      };
    });

    // Status bar: carries the idle hint when no turn is in progress, then
    // tool activity ("Editing…", "Searching the web…") during a turn, and
    // "Done · 2.3s" when it finishes.
    const statusBar = container.createDiv("gryphon-statusbar");
    this.toolbarStatus = statusBar.createEl("span", {
      text: "",
      cls: "gryphon-statusbar-text",
    });
    this._setIdleStatus();
    // Surface any warning deferred from _loadChatHistory (corrupted file,
    // permission denied, etc.) now that the status bar exists.
    if (this._pendingLoadWarning) {
      this._flashStatus(this._pendingLoadWarning);
      this._pendingLoadWarning = null;
    }

    // Toolbar (model, effort, permission, context, stop)
    const toolbar = container.createDiv("gryphon-toolbar");

    this.modelBtn = toolbar.createEl("span", {
      text: modelButtonText(this.plugin) + " \u25BE",
      cls: "gryphon-toolbar-btn",
      attr: { title: modelButtonTitle(this.plugin) },
    });
    this.modelBtn.addEventListener("click", (e) => this.showModelMenu(e));

    toolbar.createEl("span", { text: "\u00B7", cls: "gryphon-toolbar-sep" });

    this.effortBtn = toolbar.createEl("span", {
      text: labelFor(EFFORTS, this.plugin.settings.effort) + " \u25BE",
      cls: "gryphon-toolbar-btn",
      attr: { title: "Effort" },
    });
    this.effortBtn.addEventListener("click", (e) => this.showEffortMenu(e));

    toolbar.createEl("span", { text: "\u00B7", cls: "gryphon-toolbar-sep" });

    this.permBtn = toolbar.createEl("span", {
      text: labelFor(PERMS, this.plugin.settings.permissionMode) + " \u25BE",
      cls: "gryphon-toolbar-btn" +
        (this.plugin.settings.permissionMode === "bypassPermissions" ? " gryphon-perm-yolo" : ""),
      attr: { title: "Permission mode" },
    });
    this.permBtn.addEventListener("click", (e) => this.showPermMenu(e));

    toolbar.createEl("span", { text: "\u00B7", cls: "gryphon-toolbar-sep" });

    this.contextBtn = toolbar.createEl("span", {
      text: "0%",
      cls: "gryphon-toolbar-item gryphon-context-meter",
      attr: { title: "Context window usage" },
    });

    toolbar.createEl("span", { cls: "gryphon-toolbar-spacer" });

    const stopBtn = toolbar.createEl("button", { text: "Stop", cls: "gryphon-btn-stop" });
    stopBtn.addEventListener("click", () => this.stopStreaming());
    this.stopBtn = stopBtn;

    // Input area
    const inputArea = container.createDiv("gryphon-input-area");
    inputArea.createEl("span", { text: ">", cls: "gryphon-input-prompt" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "gryphon-input",
      attr: { placeholder: "Enter to send, Shift+Enter for newline", rows: "1" },
    });

    // Autocomplete dropdown (hidden until triggered)
    // The core view does not populate suggestions; extending plugins override
    // `_updateAutocomplete` if they want to offer completions.
    this.autocompleteEl = container.createDiv("gryphon-autocomplete");
    this.autocompleteEl.style.display = "none";
    this.autocompleteIdx = -1;
    // First mousemove inside the dropdown means the user has switched
    // from keyboard nav to mouse — drop the kbnav class so :hover
    // highlighting re-activates for the current mouse position.
    this.autocompleteEl.addEventListener("mousemove", () => {
      this.autocompleteEl.removeClass("gryphon-ac-kbnav");
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Autocomplete navigation
      if (this.autocompleteEl.style.display !== "none") {
        const items = this.autocompleteEl.querySelectorAll(".gryphon-ac-item");
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.autocompleteEl.addClass("gryphon-ac-kbnav");
          this.autocompleteIdx = Math.min(this.autocompleteIdx + 1, items.length - 1);
          this._highlightAcItem(items);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.autocompleteEl.addClass("gryphon-ac-kbnav");
          this.autocompleteIdx = Math.max(this.autocompleteIdx - 1, 0);
          this._highlightAcItem(items);
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && this.autocompleteIdx >= 0) {
          e.preventDefault();
          const selected = items[this.autocompleteIdx];
          if (selected) this._selectAcItem(selected.dataset.cmd);
          return;
        }
        // Tab with no selection → complete to the first match. Common
        // shell/editor convention; also saves users from having to arrow.
        if (e.key === "Tab" && items.length > 0) {
          e.preventDefault();
          this._selectAcItem(items[0].dataset.cmd);
          return;
        }
        // Enter with autocomplete open but no selection → the user is
        // mid-typing an ambiguous command (e.g. "/c" could be /clear,
        // /copy, /cost). Don't send the partial text; dismiss the dropdown
        // and let them narrow or pick. Prevents accidental forwarding to
        // the LLM for a lookup we already have the answer to.
        if (e.key === "Enter" && !e.shiftKey && items.length > 0) {
          e.preventDefault();
          const candidates = [...items].map((el) => el.dataset.cmd).join(", ");
          this._hideAutocomplete();
          this._flashStatus(`Ambiguous command \u2014 did you mean: ${candidates}?`);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this._hideAutocomplete();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
        return;
      }

      // Visual-line-aware Up/Down behavior (issues #10, #12, #13, #14).
      //
      // We don't try to predict whether the caret is on the first/last
      // visual line — three rounds of mirror-element heuristics taught
      // us that no single layout-metric threshold works across themes,
      // fonts, and the 150px max-height cap. Instead, let the browser's
      // own arrow handler run, then check whether `selectionStart`
      // actually moved. The browser is the only authoritative source
      // for "is this caret on a row boundary?" — its behavior IS the
      // answer.
      //
      //   - Caret moved to a different position → native row-by-row
      //     navigation worked. Done.
      //   - Caret didn't move → we were on the boundary row. Walk
      //     history (ArrowUp = older, ArrowDown = newer or restore).
      //
      // The history walk fires one frame later than synchronously
      // (~16ms). Imperceptible to users; eliminates the entire class
      // of "is this single-line or multi-line" guesswork.
      //
      // Current typed text is buffered into _preHistoryInput when the
      // user enters history mode, so walking past the newest entry
      // returns them to exactly what they were composing — not empty.
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const direction = e.key === "ArrowUp" ? "back" : "forward";
        const beforePos = this.inputEl.selectionStart;
        const beforeText = this.inputEl.value;
        // Don't preventDefault. Let the browser try to move the caret.
        // We check on the next frame whether it actually did.
        requestAnimationFrame(() => {
          // The textarea must still be focused and untouched; if the
          // user pressed something else in the meantime, bail.
          if (this.inputEl.value !== beforeText) return;
          const afterPos = this.inputEl.selectionStart;
          if (afterPos !== beforePos) {
            // Native navigation worked — caret moved up or down a row.
            return;
          }
          // Caret didn't move → we're on the boundary row.
          this._walkPromptHistory(direction, beforeText);
        });
        return;
      }
    });

    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
      // Any keystroke that changes the text exits history-navigation
      // mode — prevents the next ArrowUp from continuing through history
      // when the user's started composing a new message.
      this._promptHistoryIdx = null;
      this._updateAutocomplete();
      this._scrollCaretIntoView();
    });

    // Caret-into-view on navigation keys. Past the 150px max-height cap
    // the textarea becomes internally scrollable; native browsers don't
    // reliably scroll the caret into view in a constrained-height +
    // auto-resize textarea, so the caret can sit below the visible
    // region. Run on keyup so the caret position has already moved.
    this.inputEl.addEventListener("keyup", (e) => {
      if (CARET_KEYS.has(e.key)) this._scrollCaretIntoView();
    });

    this.sendBtn = inputArea.createEl("button", { text: "Send", cls: "gryphon-btn-send" });
    this.sendBtn.addEventListener("click", () => this.sendMessage());

    // Issue #40: refresh toolbar badges when settings change. Fires
    // when the user (or a consumer plugin's settings tab) changes any
    // setting and calls plugin.saveSettings() — which now triggers
    // `gryphon:settings-changed` on the Obsidian workspace bus.
    // Without this, the model / effort / permission badges stay stale
    // until the plugin is reloaded.
    if (this.app && this.app.workspace && typeof this.app.workspace.on === "function") {
      this.registerEvent(
        this.app.workspace.on("gryphon:settings-changed", () => {
          this.refreshToolbarLabels();
        }),
      );
    }
  }

  /**
   * Mirror the textarea's layout in a hidden div with a span marker at
   * the caret position, measure the marker's pixel offset, and return
   * the geometry needed by both `_scrollCaretIntoView` (issue #2) and
   * the visual-line-aware ArrowUp/Down boundary checks (issue #10).
   *
   * Returns null if the textarea is empty or unavailable. The mirror
   * element is created and removed within this call — no shared DOM
   * state outlives the measurement.
   *
   * @returns {{caretTop: number, totalHeight: number, lineHeight: number, clientHeight: number} | null}
   */
  _measureCaretGeometry() {
    const el = this.inputEl;
    if (!el) return null;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) ||
                       (parseFloat(cs.fontSize) || 13) * 1.5;
    const mirror = document.createElement("div");
    const props = [
      "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "fontFamily", "fontSize", "fontWeight", "fontStyle",
      "letterSpacing", "wordSpacing", "textTransform", "tabSize", "lineHeight",
    ];
    for (const p of props) mirror.style[p] = cs[p];
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflow = "hidden";
    mirror.style.height = "auto";
    mirror.style.left = "-9999px";
    mirror.style.top = "0";
    mirror.style.width = el.clientWidth + "px";
    const caretPos = el.selectionEnd;
    mirror.textContent = el.value.substring(0, caretPos);
    const marker = document.createElement("span");
    // Marker needs measurable layout. A trailing newline produces a
    // zero-width final span — use a period as fallback so offsetTop is
    // computed relative to the new visual line rather than the previous one.
    marker.textContent = el.value.substring(caretPos, caretPos + 1) || ".";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const caretTop = marker.offsetTop;
    const totalHeight = mirror.offsetHeight;
    document.body.removeChild(mirror);
    return {
      caretTop,
      totalHeight,
      lineHeight,
      clientHeight: el.clientHeight,
    };
  }

  /**
   * Scroll `inputEl` so the current caret is visible. The textarea wraps
   * soft lines, so a newline-count heuristic underestimates the visual
   * line of the caret; we mirror the textarea's layout in a hidden div
   * and measure the caret's pixel offset directly.
   */
  _scrollCaretIntoView() {
    const el = this.inputEl;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight) return;
    const m = this._measureCaretGeometry();
    if (!m) return;
    const visibleTop = el.scrollTop;
    const visibleBottom = visibleTop + m.clientHeight;
    if (m.caretTop < visibleTop) {
      el.scrollTop = m.caretTop;
    } else if (m.caretTop + m.lineHeight > visibleBottom) {
      el.scrollTop = m.caretTop + m.lineHeight - m.clientHeight;
    }
  }

  /**
   * Walk prompt history one step in the given direction. Called from
   * the post-frame ArrowUp/Down check (issue #14) only after we've
   * confirmed the native textarea couldn't move the caret (i.e., the
   * caret was on the boundary visual row).
   *
   * @param {"back"|"forward"} direction
   * @param {string} currentText  — the textarea value at keydown time;
   *                                used as the "pre-history input" snapshot
   *                                that `forward` can restore once the
   *                                walk passes the newest entry.
   */
  _walkPromptHistory(direction, currentText) {
    const history = this._getPromptHistory();
    const inHistoryMode = this._promptHistoryIdx !== null && this._promptHistoryIdx !== undefined;

    if (direction === "back") {
      if (history.length === 0) return;
      if (inHistoryMode) {
        if (this._promptHistoryIdx === 0) return;  // already at oldest
        this._promptHistoryIdx -= 1;
      } else {
        // Remember what was in the input so a forward-past-newest walk
        // can restore exactly what the user was composing.
        this._preHistoryInput = currentText;
        this._promptHistoryIdx = history.length - 1;
      }
      this._setInputFromHistory(history[this._promptHistoryIdx]);
      return;
    }

    // direction === "forward"
    if (!inHistoryMode) return;  // nothing newer to show when not in history
    if (this._promptHistoryIdx < history.length - 1) {
      this._promptHistoryIdx += 1;
      this._setInputFromHistory(history[this._promptHistoryIdx]);
    } else {
      // Past the newest — restore pre-history input (not empty).
      this._promptHistoryIdx = null;
      this._setInputFromHistory(this._preHistoryInput || "");
      this._preHistoryInput = null;
    }
  }

  async onClose() {
    if (this._connTimeout) { clearTimeout(this._connTimeout); this._connTimeout = null; }
    if (this._stallTimeout) { clearTimeout(this._stallTimeout); this._stallTimeout = null; }
    // Issue #34 deferred: cancel any pending rate-limit auto-retry so a
    // closed view doesn't fire a phantom resubmit after the user moved
    // on (or closed Obsidian).
    if (this._autoRetryTimeout) {
      clearTimeout(this._autoRetryTimeout);
      this._autoRetryTimeout = null;
      this._autoRetryFired = false;
    }
    if (this.claudeProcess) {
      this.claudeProcess.abort();
      this.claudeProcess = null;
    }
  }

  // ── Selection menus ──

  _showMenuAbove(menu, target) {
    const rect = target.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top });
  }

  showModelMenu(e) {
    // Provider-aware model menu, resolved via getActiveProviderKind so Auto
    // mode + only-an-OpenAI-key shows the OpenAI list (not Anthropic's
    // MODELS). Each kind has its own model list:
    //   \u2022 claude-code / anthropic-api \u2192 Anthropic MODELS
    //   \u2022 openai-api \u2192 OpenAI dropdown options (Stage 2 shipped)
    //   \u2022 google-api \u2192 still adapter-pending, Notice instead of menu (Stage 3)
    const { getActiveProviderKind } = require("@gryphon/provider-runtime");
    const kind = getActiveProviderKind(this.plugin) ||
                 this.plugin.settings.providerPreference;

    let modelList = MODELS;
    if (kind === "openai-api" || kind === "codex-cli") {
      // codex-cli reuses the OpenAI model list — both target the same
      // gpt-5 family models on the backend.
      const openaiPricing = require("@gryphon/provider-runtime").pricing.openai;
      const opts = (kind === "codex-cli")
        ? openaiPricing.getCodexCliModelDropdownOptions()
        : openaiPricing.getModelDropdownOptions();
      modelList = opts.map((o) => ({ value: o.id, label: o.label }));
    } else if (kind === "google-api" || kind === "gemini-cli") {
      // gemini-cli reuses the Gemini model list.
      const { getModelDropdownOptions } = require("@gryphon/provider-runtime").pricing.google;
      modelList = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
    }

    const menu = new Menu();
    for (const m of modelList) {
      menu.addItem((item) => {
        item.setTitle(m.label + (m.value === this.plugin.settings.model ? " \u2713" : ""))
          .setSection("model")
          .onClick(() => this.changeSetting("model", m.value, this.modelBtn, modelList));
      });
    }
    this._showMenuAbove(menu, e.target);
  }

  /**
   * Re-compute toolbar button labels in place. Called by:
   *   1. The plugin's _resetActiveSessions() \u2014 direct invocation when
   *      settings change that affect what the toolbar should display
   *      (most notably providerPreference \u2014 Bug #21).
   *   2. The `gryphon:settings-changed` workspace event (issue #40) \u2014
   *      fires from plugin.saveSettings() so consumer-plugin settings
   *      tabs that mutate plugin.settings + saveSettings() also trigger
   *      a badge refresh, not just Gryphon's own settings tab.
   *
   * Refreshes ALL toolbar buttons that are derived from plugin.settings
   * (model, effort, permission). The context-meter badge is updated
   * separately by the streaming layer.
   */
  refreshToolbarLabels() {
    if (this.modelBtn) {
      this.modelBtn.setText(modelButtonText(this.plugin) + " \u25be");
      this.modelBtn.setAttribute("title", modelButtonTitle(this.plugin));
    }
    if (this.effortBtn) {
      this.effortBtn.setText(labelFor(EFFORTS, this.plugin.settings.effort) + " \u25be");
    }
    if (this.permBtn) {
      this.permBtn.setText(labelFor(PERMS, this.plugin.settings.permissionMode) + " \u25be");
      // YOLO highlight class \u2014 toggled to match the active mode each refresh.
      const isYolo = this.plugin.settings.permissionMode === "bypassPermissions";
      this.permBtn.classList.toggle("gryphon-perm-yolo", isYolo);
    }
  }

  showEffortMenu(e) {
    const menu = new Menu();
    for (const ef of EFFORTS) {
      menu.addItem((item) => {
        item.setTitle(ef.label + (ef.value === this.plugin.settings.effort ? " \u2713" : ""))
          .setSection("effort")
          .onClick(() => this.changeSetting("effort", ef.value, this.effortBtn, EFFORTS));
      });
    }
    this._showMenuAbove(menu, e.target);
  }

  showPermMenu(e) {
    const menu = new Menu();
    for (const p of PERMS) {
      menu.addItem((item) => {
        item.setTitle(p.label + " \u2014 " + p.desc +
            (p.value === this.plugin.settings.permissionMode ? " \u2713" : ""))
          .setSection("perm")
          .onClick(() => {
            this.changeSetting("permissionMode", p.value, this.permBtn, PERMS);
            if (p.value === "bypassPermissions") {
              this.permBtn.addClass("gryphon-perm-yolo");
            } else {
              this.permBtn.removeClass("gryphon-perm-yolo");
            }
          });
      });
    }
    this._showMenuAbove(menu, e.target);
  }

  async changeSetting(key, value, btnEl, list) {
    if (this.plugin.settings[key] === value) return;

    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
    btnEl.textContent = labelFor(list, value) + " \u25BE";

    // Model, effort, and permission are spawn-time flags — kill any active
    // process so the next message picks up the new setting.
    const newLabel = labelFor(list, value);
    if (this.claudeProcess && this.claudeProcess.isAlive()) {
      this.claudeProcess.abort();
      this.claudeProcess = null;
      this._flashStatus(`${key} \u2192 ${newLabel} \u00B7 takes effect next message`);
    } else {
      this._flashStatus(`${key} \u2192 ${newLabel}`);
    }
  }

  /**
   * Apply a /model or /effort inline-set command. Validates the value,
   * persists, updates the toolbar button, and — if a process is alive —
   * aborts it so the next message spawns with the new flag. Extracted
   * from the /model and /effort handlers so both share validation and
   * status messaging.
   */
  async _applyDirectSetting(settingKey, newValue, list, btnEl, displayLabel) {
    const valid = list.find((x) => x.value === newValue);
    if (!valid) {
      this._flashStatus(
        `Unknown ${displayLabel.toLowerCase()}: ${newValue} \u2014 valid: ${list.map((x) => x.value).join(", ")}`
      );
      return;
    }
    this.plugin.settings[settingKey] = newValue;
    await this.plugin.saveSettings();
    if (btnEl) btnEl.textContent = valid.label + " \u25BE";
    if (this.claudeProcess && this.claudeProcess.isAlive()) {
      this._userInitiatedAbort = true;
      this.claudeProcess.abort();
      this.claudeProcess = null;
      this._flashStatus(`${displayLabel} \u2192 ${valid.label} \u00B7 takes effect next message`);
    } else {
      this._flashStatus(`${displayLabel} \u2192 ${valid.label}`);
    }
  }

  _refreshModelTooltip() {
    if (!this.modelBtn) return;
    const resolved = this.claudeProcess && this.claudeProcess.resolvedModel;
    this.modelBtn.setAttribute("title", resolved ? `Model: ${resolved}` : "Model");
  }

  updateContextMeter(contextTokens) {
    const model = this.plugin.settings.model || "sonnet";
    const windowSize = MODEL_CONTEXT[model] || 200000;
    const pct = Math.min(Math.round(contextTokens / windowSize * 100), 100);
    this.contextBtn.textContent = `${pct}%`;
    // Dual-side tooltip (issue #11) — used and remaining at a glance,
    // so users see both framings without needing to type /context.
    const usedK = Math.round(contextTokens / 1000);
    const remK = Math.max(0, Math.round((windowSize - contextTokens) / 1000));
    this.contextBtn.setAttribute("title",
      `Context: ${usedK}K used · ${remK}K remaining (${pct}% of ${Math.round(windowSize / 1000)}K)`);

    this.contextBtn.removeClass("gryphon-context-warn");
    this.contextBtn.removeClass("gryphon-context-danger");
    if (pct >= AUTO_COMPACT_SDK_THRESHOLD_PCT) this.contextBtn.addClass("gryphon-context-danger");
    else if (pct >= CONTEXT_WARN_PCT) this.contextBtn.addClass("gryphon-context-warn");

    // Proactive warning — flash once when the user crosses CONTEXT_WARN_PCT
    // (80%) so they can /compact manually before SDK auto-compact triggers
    // at AUTO_COMPACT_SDK_THRESHOLD_PCT (95%). Wording is provider-aware:
    // SDK names Gryphon's auto-compact, CC names Claude Code's. Reset
    // below CONTEXT_WARN_RESET_PCT (75%) so the next climb re-warns.
    if (pct >= CONTEXT_WARN_PCT && pct < AUTO_COMPACT_SDK_THRESHOLD_PCT && !this._contextWarningShown) {
      const note = this._isSdkMode()
        ? `Gryphon will auto-compact at ${AUTO_COMPACT_SDK_THRESHOLD_PCT}%`
        : "Claude Code will auto-compact near the limit";
      this._flashStatus(`Context at ${pct}% \u2014 type /compact to summarize now, or ${note}`);
      this._contextWarningShown = true;
    } else if (pct < CONTEXT_WARN_RESET_PCT && this._contextWarningShown) {
      this._contextWarningShown = false;
    }
  }

  /**
   * Whether the active provider is the Anthropic SDK (stateless \u2014 Gryphon
   * owns the history) rather than Claude Code (stateful \u2014 CC owns the
   * history). Drives auto-compact decisions: SDK mode requires Gryphon
   * to compact; CC mode delegates to Claude Code's own auto-compact.
   *
   * Source of truth is the live provider's sessionId tag (synthetic
   * `sdk-...` for SDK, real UUID for CC). Falls back to settings
   * preference when no provider is active yet.
   */
  _isSdkMode() {
    const sid = this.claudeProcess && this.claudeProcess.sessionId;
    if (sid) return String(sid).startsWith("sdk-");
    return (this.plugin.settings.providerPreference || "auto") === "anthropic-api";
  }

  /**
   * Current context-window utilization as a 0-100 integer percentage,
   * derived from the live provider's contextTokens count divided by the
   * model's window. Returns 0 when no provider has reported usage yet.
   */
  _currentContextPct() {
    const tokens = (this.claudeProcess && this.claudeProcess.contextTokens) || 0;
    if (!tokens) return 0;
    const model = this.plugin.settings.model || "sonnet";
    const windowSize = MODEL_CONTEXT[model] || 200000;
    return Math.min(100, Math.round(tokens / windowSize * 100));
  }

  // ── Plugin-handled slash commands ──
  //
  // Returns true if the command was handled here (do not forward to Claude).
  // Returns false to pass the command through to Claude.
  //
  // Full command inventory: /clear /new /copy /cost /effort /export /help
  // /model /perm /selection /settings /stop. See SLASH_COMMANDS for the
  // single source of truth used by autocomplete and /help.

  async handleChatCommand(text) {
    const cmd = text.trim().toLowerCase();

    // Dispatch table: first handler whose matcher returns true wins.
    // `text` is the raw input (preserves case + whitespace); `cmd` is
    // lowercase-trimmed for matching. Argument-taking commands pull the
    // arg from `text` to preserve case, the matcher checks `cmd`.
    const handlers = [
      { match: (c) => c === "/clear", run: () => this._cmdClearSession() },
      // Issue #28: /new (also /reset-context) clears seed context without
      // touching visible bubbles. The user sees the full history; the
      // next provider only sees turns AFTER the boundary marker.
      { match: (c) => c === "/new" || c === "/reset-context",
        run: () => this._cmdResetContext() },
      { match: (c) => c === "/compact", run: () => this._cmdCompact() },
      { match: (c) => c === "/context", run: () => this._cmdShowContext() },
      { match: (c) => c === "/cost" || c.startsWith("/cost "), run: () =>
          this._flashStatus(`Session cost: $${this.cumulativeCost.toFixed(4)}${this._costSuffix()}`) },
      { match: (c) => c === "/usage", run: () => this._cmdShowUsage() },

      { match: (c) => c === "/model", run: () =>
          this.modelBtn && this.showModelMenu({ target: this.modelBtn }) },
      { match: (c) => c.startsWith("/model "), run: () =>
          this._applyDirectSetting("model", text.trim().substring(7).trim(), MODELS, this.modelBtn, "Model") },

      { match: (c) => c === "/effort", run: () =>
          this.effortBtn && this.showEffortMenu({ target: this.effortBtn }) },
      { match: (c) => c.startsWith("/effort "), run: () =>
          this._applyDirectSetting("effort", text.trim().substring(8).trim(), EFFORTS, this.effortBtn, "Effort") },

      { match: (c) => c === "/perm" || c === "/permissions", run: () =>
          this.permBtn && this.showPermMenu({ target: this.permBtn }) },

      { match: (c) => c === "/stop", run: () =>
          this.isStreaming ? this.stopStreaming() : this._flashStatus("Nothing to stop") },

      { match: (c) => c === "/settings", run: () => this._cmdOpenSettings() },
      { match: (c) => c === "/quote", run: () => this.insertSelectionIntoInput() },
      { match: (c) => c === "/help", run: () => this._cmdShowHelp() },

      { match: (c) => c === "/export" || c.startsWith("/export "), run: () => {
          const customName = cmd === "/export" ? null : (text.trim().substring(8).trim() || null);
          return this._exportConversation(customName);
        } },

      // v1.2.0 slash command parity pass (issue #9)
      { match: (c) => c === "/version", run: () => this._cmdVersion() },
      { match: (c) => c === "/status", run: () => this._cmdStatus() },
      { match: (c) => c === "/doctor", run: () => this._cmdDoctor() },
      { match: (c) => c === "/recap", run: () => this._cmdRecap() },
      { match: (c) => c === "/init", run: () => this._cmdInitManual() },
      { match: (c) => c === "/feedback" || c.startsWith("/feedback "), run: () => {
          const arg = cmd === "/feedback" ? "" : text.trim().substring(10).trim();
          return this._cmdFeedback(arg);
        } },
      // /btw is hybrid — handled in sendMessage's pre-dispatch path so the
      // wrapped text reaches the LLM. Reaching here means /btw with no
      // args, which is just guidance.
      { match: (c) => c === "/btw", run: () =>
          this._flashStatus("/btw needs a note: type /btw <your side note>") },
    ];

    for (const h of handlers) {
      if (h.match(cmd)) {
        await h.run();
        return true;
      }
    }

    // Three-tier slash routing (Round 8):
    //   Tier 1 — Gryphon commands (SLASH_COMMANDS): handled above via
    //            the dispatch table.
    //   Tier 2 — CC built-ins known to be blocked in stream-json mode:
    //            intercepted here with a helpful message. Empirical
    //            probes show forwarding these wastes a turn or hangs.
    //   Tier 3 — Everything else starting with `/`: forwarded to CC.
    //            Likely a user-installed skill (e.g. /review,
    //            /systematic-debugging, /brainstorm) — empirically
    //            verified to fire real LLM turns in stream-json mode.
    //
    // Return true = consumed locally (no LLM turn).
    // Return false = caller should forward to the LLM.
    const first = cmd.split(/\s+/)[0];
    if (CC_BLOCKED_IN_STREAM_JSON.has(first)) {
      this._flashStatus(
        `${first} isn't supported in Gryphon \u2014 use the local CLI's own terminal for that`
      );
      return true;
    }
    return false; // probably a skill; forward to CC
  }

  /**
   * Shows a confirmation modal before /clear. Resolves to true if the
   * user clicked Clear, false if they cancelled or dismissed.
   */
  _confirmClear() {
    const { Modal, Setting } = require("obsidian");
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText("Clear conversation?");
      modal.contentEl.createEl("p", {
        text:
          "This deletes the entire chat history for this session and " +
          "starts fresh. The current conversation can't be recovered.",
      });

      let resolved = false;
      const finish = (ok) => {
        if (resolved) return;
        resolved = true;
        modal.close();
        resolve(ok);
      };

      new Setting(modal.contentEl)
        .addButton((btn) =>
          btn.setButtonText("Cancel").onClick(() => finish(false))
        )
        .addButton((btn) =>
          btn.setButtonText("Clear").setWarning().onClick(() => finish(true))
        );

      modal.onClose = () => finish(false);
      modal.open();
    });
  }

  // ── Slash command handlers ──

  async _cmdClearSession() {
    // Confirmation modal — /clear is destructive and one-keystroke. Skip
    // the modal if the session is empty (nothing to lose) so first-run
    // users don't see a redundant prompt before they've sent anything.
    const hasContent = this.messages.length > 0
      || (this._fullHistory && this._fullHistory.length > 0);
    if (hasContent) {
      const confirmed = await this._confirmClear();
      if (!confirmed) return;
    }

    if (this.claudeProcess) { this.claudeProcess.abort(); this.claudeProcess = null; }
    // Cancel any pending rate-limit auto-retry — /clear means the user
    // is resetting the session deliberately, and firing a stale retry
    // would resubmit a prompt against a now-empty conversation.
    if (this._autoRetryTimeout) {
      clearTimeout(this._autoRetryTimeout);
      this._autoRetryTimeout = null;
      this._autoRetryFired = false;
    }
    this.plugin.settings.lastSessionId = null;
    await this.plugin.saveSettings();
    this.messages = [];
    // Clear pagination state so post-/clear scroll-up can't resurrect
    // messages from the pre-clear conversation.
    this._fullHistory = [];
    this._historyLoadedUpTo = 0;
    if (this._loadMoreHint) { this._loadMoreHint.remove(); this._loadMoreHint = null; }
    this.cumulativeCost = 0;
    this.isStreaming = false;
    this.streamingEl = null;
    this.streamingBubble = null;
    this.streamingText = "";
    this._clearQueuedPrompts();
    // /clear is an explicit "reset everything" — also drop any pending
    // queued texts that _clearQueuedPrompts intentionally preserved for
    // up-arrow recall. The user asked to wipe the session, so wipe.
    this._pendingQueuedTexts = [];
    this._invalidatePromptHistoryCache();
    // Don't leave a stale queued-text in the input box from
    // _clearQueuedPrompts's recovery restore.
    if (this.inputEl) {
      this.inputEl.value = "";
      this.inputEl.style.height = "auto";
    }
    this.messagesEl.empty();
    this.updateContextMeter(0);
    // Set idle status FIRST so a save failure (which flashes its own
    // status) overwrites it and remains visible — order matters here.
    this._setIdleStatus();
    await this._saveChatHistory();
  }

  /**
   * /context — show current context-window usage as a structured
   * system message. Includes used + remaining + headroom to the next
   * two threshold transitions (80% warning, 95% auto-compact for SDK
   * mode), plus a phase-appropriate options list. More informative
   * than the older one-line status flash.
   */
  _cmdShowContext() {
    const contextTokens = (this.claudeProcess && this.claudeProcess.contextTokens) || 0;
    const model = this.plugin.settings.model || "sonnet";
    const windowSize = MODEL_CONTEXT[model] || 200000;

    if (contextTokens === 0) {
      this._flashStatus(
        `Context: 0 / ${Math.round(windowSize / 1000)}K tokens (send a message to populate)`
      );
      return;
    }

    const pct = Math.min(100, Math.round(contextTokens / windowSize * 100));
    const remaining = Math.max(0, windowSize - contextTokens);
    const usedK = Math.round(contextTokens / 1000);
    const remK = Math.round(remaining / 1000);
    const winK = Math.round(windowSize / 1000);
    const warnTokens = Math.max(0, Math.round(windowSize * CONTEXT_WARN_PCT / 100) - contextTokens);
    const compactTokens = Math.max(0, Math.round(windowSize * AUTO_COMPACT_SDK_THRESHOLD_PCT / 100) - contextTokens);
    const isSdk = this._isSdkMode();
    const autoCompactOn = this.plugin.settings.autoCompactSdk !== false;

    const userMsgs = this.messages.filter((m) => m.role === "user").length;
    const asstMsgs = this.messages.filter((m) => m.role === "assistant").length;

    const lines = [];
    lines.push(`**Context window — ${model} (${winK}K)**`);
    lines.push(`Used: ${usedK}K tokens (${pct}%)`);
    lines.push(`Remaining: ${remK}K tokens (${100 - pct}%)`);
    if (warnTokens > 0) {
      lines.push(`Headroom to ${CONTEXT_WARN_PCT}% warning: ${Math.round(warnTokens / 1000)}K tokens`);
    }
    if (compactTokens > 0) {
      const label = isSdk
        ? `${AUTO_COMPACT_SDK_THRESHOLD_PCT}% auto-compact`
        : `${AUTO_COMPACT_SDK_THRESHOLD_PCT}% (CC auto-compact threshold)`;
      lines.push(`Headroom to ${label}: ${Math.round(compactTokens / 1000)}K tokens`);
    }
    lines.push("");
    lines.push(`Messages: ${this.messages.length} (${userMsgs} user · ${asstMsgs} assistant).`);
    lines.push("");
    lines.push("**Options**");
    if (pct >= AUTO_COMPACT_SDK_THRESHOLD_PCT) {
      if (isSdk && autoCompactOn) {
        lines.push("- Auto-compact will fire at the end of this turn.");
      } else if (isSdk) {
        lines.push("- Run `/compact` now — auto-compact is off, the next send may fail with prompt-too-long.");
      } else {
        lines.push("- Claude Code will auto-compact near the limit; you can also `/compact` manually now.");
      }
      lines.push("- `/clear` to start a fresh session immediately.");
    } else if (pct >= CONTEXT_WARN_PCT) {
      lines.push("- `/compact` to summarize and continue with a fresh session seeded by the summary.");
      lines.push("- `/recap` to see a summary without resetting.");
      if (isSdk && autoCompactOn) {
        lines.push(`- Continue — auto-compact will fire at ${AUTO_COMPACT_SDK_THRESHOLD_PCT}%.`);
      } else {
        lines.push("- Continue — but consider `/compact` soon.");
      }
    } else {
      lines.push("- Continue — plenty of headroom.");
      lines.push("- `/compact` to summarize and start fresh (preserves intent, drops detail).");
      lines.push("- `/recap` to see a summary inline without resetting.");
    }
    this.addSystemMessage(lines.join("\n"));
  }

  /**
   * /usage — show combined session stats: message count, cumulative
   * cost, current context usage. More complete than /cost, which shows
   * only the dollar number.
   */
  _cmdShowUsage() {
    const contextTokens = (this.claudeProcess && this.claudeProcess.contextTokens) || 0;
    const msgCount = this.messages.length;
    const userCount = this.messages.filter((m) => m.role === "user").length;
    const asstCount = this.messages.filter((m) => m.role === "assistant").length;
    const parts = [
      `${msgCount} messages (${userCount}u / ${asstCount}a)`,
      `$${this.cumulativeCost.toFixed(4)}${this._costSuffix()}`,
    ];
    if (contextTokens > 0) {
      parts.push(`~${Math.round(contextTokens / 1000)}K ctx`);
    }
    this._flashStatus(parts.join(" \u00B7 "));
  }

  /**
   * /compact — replace the message history with an LLM-generated
   * summary so the user can continue a long conversation without
   * hitting context limits.
   *
   * Implementation: uses a structured summarization prompt (comprehensive,
   * not bullet-list) that captures decisions, file references, open
   * questions, current state, user preferences. The summary is shown in
   * chat as an "— Compaction summary —" block; the user then confirms
   * before we commit (archive old history + inject summary as system
   * prompt on next spawn). Two-step because compaction is destructive.
   *
   * Blocked while a turn is streaming (would interleave messages).
   */
  async _cmdCompact(opts = {}) {
    const auto = !!opts.auto;
    if (this.isStreaming) {
      this._flashStatus("Can't compact during an active turn \u2014 wait or /stop first");
      return;
    }
    if (!this.messages || this.messages.length < 4) {
      this._flashStatus("Nothing to compact \u2014 conversation is too short");
      return;
    }
    if (this._compactionPending) {
      this._flashStatus("Compaction already in progress");
      return;
    }

    this._compactionPending = true;
    // Auto path's caller (_maybeStartAutoCompact) already surfaced its
    // own status note; manual path needs the working indicator here.
    if (!auto) this._flashStatus("Compacting \u2026");

    const summaryPrompt =
      "Generate a comprehensive summary of our conversation that will REPLACE the full message history. Future turns will use only this summary plus new messages as context \u2014 so be thorough.\n\n" +
      "Include:\n" +
      "1. The user's overall goal and the problem being solved\n" +
      "2. Key decisions made and their rationale\n" +
      "3. Files, paths, functions, APIs, or systems discussed \u2014 with the aspects that matter (what each is for, what we've concluded about it)\n" +
      "4. Current state of any in-progress work (what's done, what's pending)\n" +
      "5. Open questions or unresolved items\n" +
      "6. User preferences, constraints, or stylistic choices expressed\n" +
      "7. Any important errors, bugs, or anti-patterns uncovered\n\n" +
      "Format: dense markdown with the sections above. Aim for 500-2000 tokens. Prioritize fidelity to specific details over brevity \u2014 reference file paths and specific decisions rather than hand-waving.";

    // Send the summary request as a normal turn but flag it so
    // finalizeStreamingMessage doesn't treat the assistant response
    // as a regular message to persist — we'll handle it specially
    // in the finalize path.
    this._compactionInProgress = true;
    try {
      // Reuse the existing send flow by programmatically invoking it
      // with the summary prompt pre-filled. The bubble will render
      // normally; on finalize we intercept to show the commit UI.
      this.inputEl.value = summaryPrompt;
      this._compactSummaryPending = true;
      await this.sendMessage();
      // sendMessage's finalize path will render the response, then our
      // post-finalize hook (_onCompactSummaryReady) prompts the user.
    } catch (err) {
      this._compactionPending = false;
      this._compactionInProgress = false;
      this._compactSummaryPending = false;
      this._flashStatus(`Compaction failed: ${err.message || err}`);
    }
  }

  /**
   * Called from finalizeStreamingMessage when a compaction summary
   * response arrives. Renders commit/cancel controls inline below the
   * summary so the user sees what will be kept and chooses to commit.
   */
  _onCompactSummaryReady(summaryText) {
    this._compactionInProgress = false;
    this._compactSummaryPending = false;

    // Auto-compact path: skip the commit/cancel UI, commit immediately,
    // drain any queued prompts (with the lag-failsafe retryText, if
    // any, dispatched first). Manual path falls through to the existing
    // commit/cancel buttons.
    if (this._autoCompactInProgress) {
      this._autoCompactInProgress = false;
      const retryText = this._autoCompactRetryText;
      this._autoCompactRetryText = null;
      (async () => {
        await this._commitCompaction(summaryText, { auto: true });
        this._compactionPending = false;
        // Retry the user's pre-compact text first (lag-failsafe path),
        // otherwise drain queued prompts in normal order.
        if (retryText) {
          setTimeout(() => {
            this.inputEl.value = retryText;
            this.sendMessage();
          }, 0);
        } else {
          this._drainQueuedPrompts();
        }
      })();
      return;
    }

    // Render commit/cancel controls attached to the last assistant bubble.
    const lastBubble = this.messagesEl.querySelector(".gryphon-message.gryphon-assistant:last-of-type");
    if (!lastBubble) return;

    const controls = this.messagesEl.createDiv("gryphon-compact-controls");
    controls.style.display = "flex";
    controls.style.gap = "8px";
    controls.style.padding = "8px 0";

    const commitBtn = controls.createEl("button", { text: "Commit compaction" });
    const cancelBtn = controls.createEl("button", { text: "Cancel" });

    const cleanup = () => {
      controls.remove();
      this._compactionPending = false;
    };

    commitBtn.addEventListener("click", async () => {
      commitBtn.disabled = true;
      cancelBtn.disabled = true;
      await this._commitCompaction(summaryText);
      cleanup();
    });
    cancelBtn.addEventListener("click", () => {
      this._flashStatus("Compaction cancelled \u2014 history unchanged");
      cleanup();
    });

    this._flashStatus("Review summary \u2014 Commit or Cancel below");
  }

  /**
   * Commit a compaction: archive the current chat-history, clear the
   * message buffer, abort the current session, and store the summary
   * so the next spawn injects it via --append-system-prompt.
   */
  async _commitCompaction(summaryText, opts = {}) {
    try {
      // Archive current history to a .bak file the user can inspect.
      const realPath = this._chatHistoryPath();
      const backup = `${realPath}.bak-compact-${Date.now()}`;
      try {
        if (fs.existsSync(realPath)) fs.renameSync(realPath, backup);
      } catch (e) {
        console.warn("[gryphon] compaction backup rename failed:", e.message);
      }
      // Persist the summary for the NEXT spawn to pick up.
      this.plugin.settings.compactionSummary = summaryText;
      this.plugin.settings.lastSessionId = null;
      await this.plugin.saveSettings();

      // Reset state: memory, UI, process.
      if (this.claudeProcess) { this.claudeProcess.abort(); this.claudeProcess = null; }
      this.messages = [];
      this._fullHistory = [];
      this._historyLoadedUpTo = 0;
      this.cumulativeCost = 0;
      this.messagesEl.empty();

      // Marker so the user sees that compaction happened. Distinguish
      // auto vs manual so a returning user can scan the transcript and
      // tell which compactions they triggered themselves.
      const when = new Date().toLocaleTimeString();
      const label = opts.auto ? "Auto-compacted" : "Compacted";
      this.addSystemMessage(`\u2014 ${label} at ${when}. Fresh session seeded with the summary. \u2014`);
      this.updateContextMeter(0);
      this._setIdleStatus();
    } catch (err) {
      this._flashStatus(`Compaction commit failed: ${err.message || err}`);
    }
  }

  _cmdOpenSettings() {
    if (this.app.setting && typeof this.app.setting.open === "function") {
      this.app.setting.open();
      if (typeof this.app.setting.openTabById === "function") {
        this.app.setting.openTabById(this.plugin.manifest.id);
      }
    } else {
      this._flashStatus("Settings unavailable in this Obsidian version");
    }
  }

  // ── v1.2.0 slash commands (issue #9) ──

  /**
   * Build the diagnostic context shared by /version, /status, /doctor,
   * and the /feedback prefill. Returns a plain object — callers format
   * it as text, markdown, or query-string parameters as needed.
   *
   * NEVER includes any conversation content. Only metadata.
   */
  _buildDiagnosticContext() {
    const settings = this.plugin.settings || {};
    const provider = (() => {
      const sid = this.claudeProcess && this.claudeProcess.sessionId;
      if (sid && String(sid).startsWith("sdk-")) return "anthropic-api";
      if (sid) return "claude-code";
      return settings.providerPreference || "auto";
    })();
    const tokens = (this.claudeProcess && this.claudeProcess.contextTokens) || 0;
    const model = settings.model || "sonnet";
    const windowSize = MODEL_CONTEXT[model] || 200000;
    const ctxPct = tokens > 0 ? Math.round(tokens / windowSize * 100) : 0;
    let obsidianVersion = "unknown";
    try {
      if (this.app && this.app.appInfo && this.app.appInfo.appVersion) {
        obsidianVersion = String(this.app.appInfo.appVersion);
      } else if (typeof require === "function") {
        // Electron renderer exposes process.versions
        if (typeof process !== "undefined" && process.versions && process.versions.electron) {
          obsidianVersion = `electron-${process.versions.electron}`;
        }
      }
    } catch {}
    let osDesc = "unknown";
    try {
      const os = require("os");
      osDesc = `${os.platform()} ${os.release()}`;
    } catch {}
    return {
      pluginVersion: (this.plugin.manifest && this.plugin.manifest.version) || "unknown",
      provider,
      model,
      effort: settings.effort || "high",
      permissionMode: settings.permissionMode || "default",
      protectedMode: settings.protectedMode !== false,
      autoCompactSdk: settings.autoCompactSdk !== false,
      obsidianVersion,
      os: osDesc,
      messageCount: (this.messages || []).length,
      cumulativeCost: this.cumulativeCost || 0,
      contextTokens: tokens,
      contextPct: ctxPct,
      windowSize,
      hasApiKey: !!(settings.anthropicApiKey || (typeof process !== "undefined" && process.env && process.env.ANTHROPIC_API_KEY)),
      hasClaudeCli: !!settings.claudePath,
    };
  }

  /**
   * /version — quick one-glance system info.
   */
  _cmdVersion() {
    const d = this._buildDiagnosticContext();
    const text =
      `**Gryphon v${d.pluginVersion}**\n` +
      `Provider: ${d.provider} · Model: ${d.model} · Effort: ${d.effort}\n` +
      `Obsidian: ${d.obsidianVersion} · OS: ${d.os}`;
    this.addSystemMessage(text);
  }

  /**
   * /status — unified session-status panel.
   */
  _cmdStatus() {
    const d = this._buildDiagnosticContext();
    const ctxLine = d.contextTokens > 0
      ? `${Math.round(d.contextTokens / 1000)}K / ${Math.round(d.windowSize / 1000)}K tokens (${d.contextPct}%)`
      : `0 / ${Math.round(d.windowSize / 1000)}K tokens (no usage yet)`;
    const lines = [
      `**Session status**`,
      `Provider: ${d.provider}`,
      `Model: ${d.model} · Effort: ${d.effort}`,
      `Permissions: ${d.permissionMode} · Protected mode: ${d.protectedMode ? "on" : "off"}`,
      `Context: ${ctxLine}`,
      `Messages: ${d.messageCount} · Cost: $${d.cumulativeCost.toFixed(4)}${this._costSuffix()}`,
      `Auto-compact (SDK): ${d.autoCompactSdk ? "on (95%)" : "off"}`,
    ];
    this.addSystemMessage(lines.join("\n"));
  }

  /**
   * /doctor — diagnostics dump for bug reports. Includes a network
   * reachability test (HEAD https://api.anthropic.com/v1/) so users on
   * a corporate / firewalled network see the failure mode in the same
   * panel as the rest of the metadata.
   */
  async _cmdDoctor() {
    this._flashStatus("Running diagnostics …");
    const d = this._buildDiagnosticContext();
    const settings = this.plugin.settings || {};
    const path = require("path");
    const fs = require("fs");
    let pluginDir = null;
    try {
      pluginDir = path.join(
        this.app.vault.adapter.basePath,
        ".obsidian", "plugins", this.plugin.manifest.id
      );
    } catch {}
    const expectHooks = [
      "hooks/pretool.js",
      "hooks/posttool.js",
      "hooks/session-start.js",
      "hooks/session-end.js",
      "hooks/user-prompt.js",
      "hooks/notification.js",
      "hooks/common/ipc-client.js",
    ];
    const hookStatus = expectHooks.map((rel) => {
      if (!pluginDir) return `${rel}: ?`;
      const full = path.join(pluginDir, rel);
      return fs.existsSync(full) ? `${rel}: ✓` : `${rel}: ✗ MISSING`;
    });
    let networkLine = "Network: not tested";
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch("https://api.anthropic.com/v1/", {
        method: "HEAD",
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      networkLine = `Network: api.anthropic.com reachable (HTTP ${resp.status})`;
    } catch (e) {
      networkLine = `Network: api.anthropic.com unreachable — ${(e && e.message) || e}`;
    }
    let ipcLine = "IPC: not tested";
    try {
      if (this.plugin && typeof this.plugin.ensureIpcListening === "function") {
        const ok = await this.plugin.ensureIpcListening(2000);
        ipcLine = ok ? "IPC: listening" : "IPC: NOT listening (CLI mode protections degraded)";
      }
    } catch (e) {
      ipcLine = `IPC: error — ${(e && e.message) || e}`;
    }
    const lines = [
      `**Gryphon diagnostics**`,
      ``,
      `Plugin: v${d.pluginVersion}`,
      `Obsidian: ${d.obsidianVersion} · OS: ${d.os}`,
      `Provider: ${d.provider} (preference: ${settings.providerPreference || "auto"})`,
      `Model: ${d.model} · Effort: ${d.effort} · Permissions: ${d.permissionMode}`,
      `Anthropic API key: ${d.hasApiKey ? "present" : "NOT SET"}`,
      `Claude Code path: ${d.hasClaudeCli ? settings.claudePath : "(not configured)"}`,
      `Plugin directory: ${pluginDir || "(unknown)"}`,
      ``,
      `**Hook scripts**`,
      ...hookStatus,
      ``,
      ipcLine,
      networkLine,
    ];
    this.addSystemMessage(lines.join("\n"));
    this._flashStatus("Diagnostics complete");
  }

  /**
   * /recap — summarize the conversation as a regular bubble without
   * committing the compaction. Useful mid-conversation snapshot.
   * Reuses the same summary prompt as /compact for consistency.
   */
  async _cmdRecap() {
    if (this.isStreaming) {
      this._flashStatus("Can't /recap during an active turn — wait or /stop first");
      return;
    }
    if (!this.messages || this.messages.length < 4) {
      this._flashStatus("Nothing to recap — conversation is too short");
      return;
    }
    const recapPrompt =
      "Generate a concise recap of our conversation so far — what we've " +
      "discussed, decisions made, current state of any in-progress work, " +
      "and open questions. This is a snapshot for the user to review " +
      "mid-conversation, NOT a replacement for the conversation history. " +
      "Keep it tight (300-700 tokens). Don't ask if I want to continue.";
    this.inputEl.value = recapPrompt;
    await this.sendMessage();
  }

  /**
   * /init — scaffold Gryphon/MANUAL.md if it doesn't already exist.
   * Won't overwrite an existing file. Opens the file for editing if
   * it was created.
   */
  async _cmdInitManual() {
    const path = require("path");
    const fs = require("fs");
    const vaultPath = this.app.vault.adapter.basePath;
    const manualRel = "Gryphon/MANUAL.md";
    const manualAbs = path.join(vaultPath, manualRel);
    if (fs.existsSync(manualAbs)) {
      this._flashStatus(`Gryphon/MANUAL.md already exists — opening`);
      try { this.app.workspace.openLinkText(manualRel, ""); } catch {}
      return;
    }
    const template =
      "# Gryphon — Vault Manual\n\n" +
      "This file is your personal scratchpad for Gryphon — anything you'd " +
      "like the model to know about your vault, your conventions, your " +
      "in-progress projects. Gryphon doesn't auto-read it (so you control " +
      "when it's seen), but you can paste from here, reference it via " +
      "`/quote`, or copy excerpts into your messages.\n\n" +
      "## About this vault\n\n" +
      "_(your notes — what's the vault for, who you are, what conventions you follow)_\n\n" +
      "## Active projects\n\n" +
      "_(things you're working on, with links to relevant notes via `[[wikilinks]]`)_\n\n" +
      "## Conventions\n\n" +
      "_(folder structure, tagging style, link patterns, anything else worth knowing)_\n\n" +
      "## Personal context\n\n" +
      "_(role, expertise, preferences — anything that helps the model talk to you usefully)_\n\n" +
      "## Skills\n\n" +
      "Custom slash commands live in `Gryphon/Skills/`. Each `.md` file becomes a " +
      "`/<name>` command. See the bundled skills folder for examples.\n";
    try {
      const dir = path.dirname(manualAbs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(manualAbs, template);
      this.addSystemMessage(`Created [[Gryphon/MANUAL]] — opening for editing`);
      try { this.app.workspace.openLinkText(manualRel, ""); } catch {}
    } catch (e) {
      this._flashStatus(`Failed to create MANUAL.md: ${(e && e.message) || e}`);
    }
  }

  /**
   * /feedback — open a modal that lets the user pick how they want to
   * send feedback. With args, defaults to mailto with the args as body.
   * Never auto-sends; every path opens a draft (browser tab or mail
   * composer) for the user to review and submit manually.
   *
   * Diagnostic context (versions, provider, mode) is prefilled. NO
   * conversation content is included unless the user pastes it.
   */
  _cmdFeedback(arg) {
    const userText = (arg || "").trim();
    if (!userText) {
      this._showFeedbackModal();
      return;
    }
    // Args path: default to mailto with diagnostics appended.
    this._openFeedbackMailto(userText);
  }

  _buildFeedbackDiagText() {
    const d = this._buildDiagnosticContext();
    return [
      `Plugin version: ${d.pluginVersion}`,
      `Provider: ${d.provider}`,
      `Model: ${d.model} · Effort: ${d.effort}`,
      `Permissions: ${d.permissionMode}`,
      `Obsidian: ${d.obsidianVersion} · OS: ${d.os}`,
    ].join("\n");
  }

  _openFeedbackMailto(userText) {
    const subject = encodeURIComponent("Gryphon feedback");
    const body = encodeURIComponent(
      `${userText || "(write your feedback here)"}\n\n---\n${this._buildFeedbackDiagText()}\n`
    );
    const url = `mailto:contact@polleo.ai?subject=${subject}&body=${body}`;
    try { window.open(url); } catch {}
    this._flashStatus("Opened feedback email — review and send from your mail app");
  }

  _openFeedbackIssueTracker(userText) {
    const title = encodeURIComponent("[Bug] ");
    const body = encodeURIComponent(
      `${userText || "Describe the issue here…"}\n\n` +
      `**Steps to reproduce:**\n1. \n2. \n\n` +
      `**Expected:**\n\n**Actual:**\n\n` +
      `---\n${this._buildFeedbackDiagText()}\n`
    );
    const url = `https://github.com/polleoai/gryphon/issues/new?title=${title}&body=${body}`;
    try { window.open(url); } catch {}
    this._flashStatus("Opened issue tracker — review and submit");
  }

  _showFeedbackModal() {
    const { Modal, Setting } = require("obsidian");
    const modal = new Modal(this.app);
    modal.titleEl.setText("Send feedback");

    const note = modal.contentEl.createEl("p");
    note.style.marginBottom = "0.8em";
    note.setText(
      "Gryphon never auto-sends — every option opens a draft you review " +
      "first. Conversation content is NOT included unless you paste it " +
      "yourself. Diagnostic context (plugin version, provider, model, " +
      "OS) IS included so we can reproduce."
    );

    const diagBox = modal.contentEl.createEl("pre");
    diagBox.style.fontSize = "0.85em";
    diagBox.style.padding = "0.5em";
    diagBox.style.background = "var(--background-secondary)";
    diagBox.style.borderRadius = "4px";
    diagBox.style.marginBottom = "1em";
    diagBox.setText(this._buildFeedbackDiagText());

    new Setting(modal.contentEl)
      .setName("Report a bug")
      .setDesc("Opens a GitHub issue draft with diagnostic context prefilled.")
      .addButton((b) => b.setButtonText("Open issue tracker").onClick(() => {
        modal.close();
        this._openFeedbackIssueTracker("");
      }));

    new Setting(modal.contentEl)
      .setName("Send a quick note")
      .setDesc("Opens a draft email to contact@polleo.ai.")
      .addButton((b) => b.setButtonText("Open email").onClick(() => {
        modal.close();
        this._openFeedbackMailto("");
      }));

    new Setting(modal.contentEl)
      .setName("Browse issues")
      .setDesc("Opens the public issue tracker without prefilling anything.")
      .addButton((b) => b.setButtonText("Open issues page").onClick(() => {
        modal.close();
        try { window.open("https://github.com/polleoai/gryphon/issues"); } catch {}
      }));

    modal.open();
  }

  /**
   * /help — show all slash commands and keyboard shortcuts in a modal.
   * The slash list is the authoritative inventory in constants.js, so
   * this stays drift-free as commands are added.
   */
  _cmdShowHelp() {
    const { Modal } = require("obsidian");
    const modal = new Modal(this.app);
    modal.titleEl.setText("Gryphon — commands & shortcuts");

    const body = modal.contentEl;
    body.createEl("h3", { text: "Slash commands" });
    const cmdTable = body.createEl("table", { cls: "gryphon-help-table" });
    const cmdBody = cmdTable.createEl("tbody");
    for (const c of SLASH_COMMANDS) {
      const row = cmdBody.createEl("tr");
      row.createEl("td", { text: c.cmd, cls: "gryphon-help-key" });
      row.createEl("td", { text: c.desc });
    }

    body.createEl("h3", { text: "Keyboard shortcuts" });
    const kbTable = body.createEl("table", { cls: "gryphon-help-table" });
    const kbBody = kbTable.createEl("tbody");
    const shortcuts = [
      ["Enter", "Send message"],
      ["Shift+Enter", "Newline"],
      ["↑ (cursor not at start)", "Jump cursor to start of prompt"],
      ["↑ (cursor at start, or empty)", "Walk back through prompt history"],
      ["↓ (cursor not at end)", "Jump cursor to end of prompt"],
      ["↓ (cursor at end, in history)", "Walk forward through prompt history"],
      ["Tab / Enter (in autocomplete)", "Complete selected command"],
      ["Esc (in autocomplete)", "Close dropdown"],
    ];
    for (const [key, desc] of shortcuts) {
      const row = kbBody.createEl("tr");
      row.createEl("td", { text: key, cls: "gryphon-help-key" });
      row.createEl("td", { text: desc });
    }

    body.createEl("h3", { text: "Skills" });
    body.createEl("p", {
      text:
        "Type /<skill-name> to invoke a custom skill. Skills are .md files " +
        "in your vault's Gryphon/Skills/ folder — see the README there for " +
        "the file format. Five examples ship pre-populated.",
    });

    body.createEl("h3", { text: "Full manual" });
    const manualP = body.createEl("p");
    manualP.createSpan({
      text: "For permission modes, settings reference, troubleshooting, and where to ask for help, see ",
    });
    const manualLink = manualP.createEl("a", {
      text: "Gryphon/MANUAL.md",
      href: "#",
    });
    manualLink.addEventListener("click", (e) => {
      e.preventDefault();
      modal.close();
      this.app.workspace.openLinkText("Gryphon/MANUAL", "");
    });
    manualP.createSpan({ text: " in your vault." });

    modal.open();
  }

  /**
   * Detect a skill invocation and return the expanded prompt, or null
   * if the input doesn't name a registered skill. Expansion substitutes
   * `{{args}}` in the skill body with whatever the user typed after the
   * command name (may be empty).
   */
  _maybeExpandSkill(text) {
    const registry = this.plugin && this.plugin.skillRegistry;
    if (!registry || !text.startsWith("/")) return null;
    const space = text.indexOf(" ");
    const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim();
    if (!name || !registry.has(name)) return null;
    const args = space === -1 ? "" : text.slice(space + 1).trim();
    return registry.expand(name, args);
  }

  stopStreaming() {
    // Run plugin-registered cleanup BEFORE core teardown so hooks see the
    // still-live state (e.g. streamingEl, claudeProcess) if they need it.
    // Each hook gets `this` so it can inspect/mutate view-local state
    // (e.g. subprocess handles owned by the consuming plugin).
    for (const hook of this.stopStreamingHooks) {
      try { hook(this); }
      catch (e) { console.warn("[gryphon] stopStreaming hook error:", e); }
    }
    if (this.streamingText) {
      // User stopped mid-stream — keep the partial bubble; status confirms.
      const partial = this.streamingText;
      this.streamingText = "";
      this._cleanupStreamingState({ bubbleText: partial, doneStatus: "Stopped" });
    } else if (this.streamingEl) {
      // User stopped before any text arrived — empty bubble needs text.
      this._cleanupStreamingState({ bubbleText: "(stopped)", doneStatus: "Stopped" });
    } else {
      // No active stream (no bubble) — just flash confirmation.
      this._cleanupStreamingState({ fallbackFlash: "Stopped" });
    }
  }

  /**
   * Single source of truth for tearing down streaming state. Both
   * `stopStreaming()` (user-initiated) and the connection-timeout handler
   * (time-initiated) go through here to prevent the two paths from
   * drifting apart (R3-1 was exactly that divergence: timeout forgot to
   * reset `sendBtn` and null `claudeProcess`).
   *
   * Options:
   *   bubbleText   — if provided and streamingEl exists, calls
   *                  finalizeStreamingMessage(bubbleText, doneStatus) to
   *                  seal the bubble and set the status bar.
   *   doneStatus   — passed to finalizeStreamingMessage; becomes the
   *                  status-bar text after the turn (e.g. "Stopped",
   *                  "Timed out").
   *   fallbackFlash — if no bubble exists to finalize, this string is
   *                   flashed to the status bar instead.
   *
   * Always performs: abort+null claudeProcess, isStreaming=false, queued
   * prompts cleared. These cannot be skipped — they're the invariant.
   */
  _cleanupStreamingState({ bubbleText, doneStatus, fallbackFlash } = {}) {
    if (this.claudeProcess) { this.claudeProcess.abort(); this.claudeProcess = null; }
    this.isStreaming = false;
    this._clearQueuedPrompts();
    // Issue #36: every path through here is an abort or timeout — the
    // turn didn't complete. Mark the just-sent user prompt as failed
    // BEFORE finalizeStreamingMessage triggers a save, so the save
    // filter (which otherwise drops CLI llm messages on the assumption
    // CC's jsonl has them) preserves the prompt for up-arrow recall.
    this._markLastUserPromptFailed();
    if (bubbleText !== undefined && this.streamingEl) {
      this.finalizeStreamingMessage(bubbleText, doneStatus);
    } else if (fallbackFlash) {
      this._flashStatus(fallbackFlash);
    }
  }

  /**
   * Issue #36: walk back from the tail of `this.messages` and tag the
   * most recent unflagged `source: "llm"`, `role: "user"` entry with
   * `failed: true`. Called by every abort/timeout cleanup so the save
   * filter preserves prompts the CLI never received. Bounded scan (10
   * entries) — the user prompt is at most a few entries back from the
   * tail in any abort scenario.
   */
  _markLastUserPromptFailed() {
    if (!Array.isArray(this.messages)) return;
    for (let i = this.messages.length - 1, n = 0; i >= 0 && n < 10; i--, n++) {
      const m = this.messages[i];
      if (!m) continue;
      if (m.role === "user" && m.source === "llm") {
        // Idempotent: if already flagged, leave it (and don't walk
        // past to flag an older prompt — the older one belonged to a
        // different turn). If not yet flagged, flag it once.
        if (!m.failed) m.failed = true;
        return;
      }
    }
  }

  // ── Streaming-input queue (issue #3) ──
  //
  // While a turn is streaming, additional non-slash prompts the user
  // sends are queued instead of being dropped. Each queued prompt
  // immediately renders a dimmed user bubble (so the user sees it was
  // accepted) but is NOT pushed into `this.messages` until it actually
  // fires — that way persistence and provider history stay in sync with
  // the order prompts are dispatched.

  _enqueuePrompt(text) {
    const msgEl = this.messagesEl.createDiv("gryphon-message gryphon-user gryphon-queued");
    const bubble = msgEl.createDiv("gryphon-bubble gryphon-bubble-user gryphon-bubble-queued");
    bubble.createEl("span", { text: "> ", cls: "gryphon-prompt-prefix" });
    bubble.createEl("span", { text, cls: "gryphon-text" });
    bubble.createEl("span", { text: " · queued", cls: "gryphon-queued-tag" });
    this._queuedPrompts.push({ text, bubbleEl: msgEl });
    this._pendingQueuedTexts.push(text);
    // Up-arrow recall reads merged history; queued texts need to show
    // up there so the user can recall an unsent prompt. Invalidate.
    this._invalidatePromptHistoryCache();
    this.scrollToBottom();
    this._flashStatus(`Queued (${this._queuedPrompts.length} pending) — will send after this turn`);
  }

  /**
   * Cleanup queued prompts on stop / timeout / error. Removes the DOM
   * bubbles AND restores the oldest queued text to the input box if the
   * box is empty (so the user can re-fire it with one keystroke).
   * Texts stay recorded in `_pendingQueuedTexts` so up-arrow recall can
   * still walk back to any queued message that didn't get a chance to
   * fire — this is what protects the user from "I queued 3 messages
   * during a slow turn, the model timed out, and now they're all gone."
   */
  _clearQueuedPrompts() {
    if (!this._queuedPrompts || this._queuedPrompts.length === 0) return;
    const queuedCount = this._queuedPrompts.length;
    const oldestText = this._queuedPrompts[0] && this._queuedPrompts[0].text;
    for (const q of this._queuedPrompts) {
      if (q.bubbleEl && q.bubbleEl.parentElement) q.bubbleEl.remove();
    }
    this._queuedPrompts = [];
    // Restore the oldest queued text into the input box for one-keystroke
    // retry — but only if the user hasn't already started typing
    // something else. The other queued texts (if any) remain reachable
    // via up-arrow recall through `_pendingQueuedTexts`.
    if (oldestText && this.inputEl && !this.inputEl.value.trim()) {
      this.inputEl.value = oldestText;
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
      this.inputEl.selectionStart = this.inputEl.selectionEnd = oldestText.length;
    }
    if (queuedCount > 0) {
      const tail = queuedCount > 1
        ? ` (and ${queuedCount - 1} more — type ↑ to recall)`
        : "";
      this._flashStatus(`Restored your queued prompt${tail}`);
    }
  }

  _drainQueuedPrompts() {
    if (!this._queuedPrompts || this._queuedPrompts.length === 0) return;
    const next = this._queuedPrompts.shift();
    if (next.bubbleEl && next.bubbleEl.parentElement) next.bubbleEl.remove();
    // The text is about to fire through the normal send pipeline, where
    // `addUserMessage` will record it in this.messages — so drop our
    // pending-text shadow record (first matching entry) to avoid showing
    // the same prompt twice in up-arrow recall after it sends.
    const idx = this._pendingQueuedTexts.indexOf(next.text);
    if (idx >= 0) this._pendingQueuedTexts.splice(idx, 1);
    this._invalidatePromptHistoryCache();
    // Defer one tick so the just-completed turn's finalize DOM work
    // settles first. Restore the prompt text into the input on the same
    // tick we call sendMessage so the user never sees the queued text
    // flash in the textarea — sendMessage clears it on entry.
    setTimeout(() => {
      this.inputEl.value = next.text;
      this.sendMessage();
    }, 0);
  }

  // ── SDK auto-compact gate (issue #5 / v1.1.0) ──
  //
  // Anthropic API mode is stateless — Gryphon owns the entire history
  // array, so without auto-compaction a long conversation eventually
  // 4xx's mid-turn with "prompt is too long". Mirror Claude Code's own
  // ~95% threshold by triggering the existing manual-compact machinery
  // automatically (skipping the user-confirmation step). CC mode is
  // never auto-compacted from here — Claude Code handles its own.

  /**
   * Decide whether to start an auto-compact. Returns true if a
   * compaction was triggered (caller should NOT drain queued prompts —
   * the auto-compact's commit handler will drain instead). Returns
   * false otherwise.
   *
   * @param {{ lagFailsafe?: boolean, retryText?: string }} opts
   *   lagFailsafe — bypasses the percentage threshold; used by
   *                 sendMessage's catch branch when the SDK returned
   *                 "prompt is too long" despite our last reading
   *                 being below 95%.
   *   retryText  — original user text to re-send post-commit. Set on
   *                the lag-failsafe path so the user's intended message
   *                still reaches the model.
   */
  _maybeStartAutoCompact(opts = {}) {
    if (this._compactionPending || this._compactionInProgress) return false;
    if (!this._isSdkMode()) return false;

    const pct = this._currentContextPct();
    const overThreshold = pct >= AUTO_COMPACT_SDK_THRESHOLD_PCT;

    // Opt-out path: at threshold, surface a louder warning instead of
    // triggering. Below threshold, just stay silent — the 80% warning
    // already fired.
    if (this.plugin.settings.autoCompactSdk === false) {
      if (overThreshold || opts.lagFailsafe) {
        this._flashStatus(
          `Context at ${pct}% — auto-compact disabled. Run /compact manually before the next send.`
        );
      }
      return false;
    }

    if (!opts.lagFailsafe && !overThreshold) return false;
    if (!this.messages || this.messages.length < 4) return false;

    this._autoCompactInProgress = true;
    this._autoCompactRetryText = opts.retryText || null;
    const reasonNote = opts.lagFailsafe
      ? "context overflowed"
      : `${pct}%`;
    this._flashStatus(
      `Auto-compacting (${reasonNote}) — fresh session will start after this.`
    );
    this._cmdCompact({ auto: true }).catch((err) => {
      console.warn("[gryphon] auto-compact failed:", err);
      this._autoCompactInProgress = false;
      const retryText = this._autoCompactRetryText;
      this._autoCompactRetryText = null;
      this._flashStatus(`Auto-compact failed: ${err.message || err}`);
      // Recovery: drain queued prompts so the user's pending sends still
      // dispatch (against the still-bloated provider, which may itself
      // overflow — but that surfaces as a normal error rather than a
      // silent drop).
      if (retryText) {
        setTimeout(() => {
          this.inputEl.value = retryText;
          this.sendMessage();
        }, 0);
      } else {
        this._drainQueuedPrompts();
      }
    });
    return true;
  }

  /**
   * Last-resort defense when the compaction's own summarization turn
   * overflows the context window. Drops the oldest entries from the
   * SDK provider's in-memory history array, keeping only the most
   * recent `keepRecent` turns. Returns true if any trimming happened
   * (caller should retry the summary turn). Returns false if there's
   * nothing to trim or the provider doesn't expose a history (e.g.,
   * CC mode — but this path is gated to SDK mode upstream anyway).
   *
   * Anthropic message-pair invariant: messages must alternate user /
   * assistant. After splicing we may land on an assistant turn first;
   * trim one extra so the slice starts with a user turn.
   */
  _emergencyTrim(provider, keepRecent = 8) {
    if (!provider || !Array.isArray(provider.history)) return false;
    if (provider.history.length <= keepRecent) return false;
    const original = provider.history.length;
    provider.history.splice(0, provider.history.length - keepRecent);
    if (provider.history[0] && provider.history[0].role !== "user") {
      provider.history.shift();
    }
    console.warn(
      `[gryphon] emergency-trim: dropped ${original - provider.history.length} ` +
      `messages from SDK history (kept ${provider.history.length})`
    );
    return true;
  }

  // ── Chat history (unified: local + CLI session) ──
  //
  // Two sources, merged by timestamp:
  //   1. chat-history.json — plugin-only messages (slash commands, system
  //      notices) that the local CLI doesn't see
  //   2. Local CLI .jsonl — LLM conversations (user prompts, assistant
  //      responses) in ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
  //
  // We store ONLY what the CLI doesn't (source !== "llm"). The CLI
  // handles the bulk, so our local file stays small.

  /**
   * Project the persisted UI-message log into Anthropic-API message
   * shape for SDK seeding. Drops system notices, slash-command chatter,
   * and mechanical messages — only user ↔ assistant LLM exchanges go
   * into the model's context. Returns [] if there's nothing to seed.
   *
   * Cap: last MAX_SDK_SEED_TURNS entries, to keep token cost bounded
   * after long conversations. Users who need more can /clear and start
   * fresh, or the model can reason from the persisted UI history shown
   * above the input box.
   */
  /**
   * Issue #30: stats from the last `_extractLlmTurnsFromFullHistory`
   * call. `dropped` is the count of llm turns that were over the cap
   * and got silently truncated. Used by the provider-change notice
   * (#29) to surface truncation to the user instead of letting it
   * happen invisibly.
   *
   * Stored on `this` rather than threaded through return shapes so the
   * existing call sites (which only consume the seed array) don't have
   * to change. Read AFTER calling `_extractLlmTurnsFromFullHistory`.
   */
  _extractLlmTurnsFromFullHistory() {
    // Issue #30: scale the seed cap by the active model's context window.
    // The pre-fix hard-coded 100 was a sensible default for 200K-window
    // Anthropic models — but for users on Opus 1M / Sonnet 1M the model
    // can comfortably hold 5× more conversation. Limiting them to the
    // same 100 turns silently dropped early context after Provider /
    // Model switches with no UI signal.
    //
    // Linear scaling against a 200K baseline (the original cap's
    // implicit assumption): 200K → 100, 1M → 500. Falls back to 100
    // when the model id isn't in MODEL_CONTEXT (Openai / Gemini ids
    // not yet enrolled — strictly safer than a larger guess that could
    // overflow an unknown model's actual window).
    const SEED_CAP_BASE = 100;
    const SEED_CAP_BASE_WINDOW = 200_000;
    const model = (this.plugin && this.plugin.settings && this.plugin.settings.model) || "";
    const window = MODEL_CONTEXT[model] || SEED_CAP_BASE_WINDOW;
    const MAX_SDK_SEED_TURNS = Math.max(
      SEED_CAP_BASE,
      Math.round(SEED_CAP_BASE * (window / SEED_CAP_BASE_WINDOW)),
    );
    // Reset the truncation stats up front so a no-history return below
    // doesn't leave a stale value from a prior call. The notice path
    // (#29) reads these AFTER each extraction.
    this._lastSeedStats = { kept: 0, dropped: 0, cap: MAX_SDK_SEED_TURNS };
    if (!this._fullHistory || this._fullHistory.length === 0) return [];
    // Issue #28: respect the most recent /new (`context-reset`) boundary
    // marker. Anything before it stays in the visible chat (so the user
    // can scroll back) but is NOT sent to the next provider as seed
    // history. This is the privacy escape hatch — switch from Anthropic
    // to OpenAI without leaking the prior conversation.
    let history = this._fullHistory;
    let lastResetIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].source === "context-reset") {
        lastResetIdx = i;
        break;
      }
    }
    if (lastResetIdx >= 0) {
      history = history.slice(lastResetIdx + 1);
    }
    const llmOnly = history.filter(
      (m) => m.source === "llm" && (m.role === "user" || m.role === "assistant")
    );
    // Issue #30: record how many llm turns were dropped by the cap so
    // the provider-change notice (#29) can tell the user "older N turns
    // were silently dropped" instead of letting truncation happen
    // invisibly. Only counts what the cap drops — pre-/new turns
    // stripped above are an explicit user choice and don't surface as
    // "loss" in the notice.
    const dropped = Math.max(0, llmOnly.length - MAX_SDK_SEED_TURNS);
    const tail = llmOnly.slice(-MAX_SDK_SEED_TURNS);
    // Ensure we start with a user turn — Anthropic's API rejects
    // histories that begin with an assistant message.
    const firstUserIdx = tail.findIndex((m) => m.role === "user");
    if (firstUserIdx < 0) return [];
    const seed = tail.slice(firstUserIdx).map((m) => ({
      role: m.role,
      content: m.text,
    }));
    this._lastSeedStats = {
      kept: seed.length,
      dropped,
      cap: MAX_SDK_SEED_TURNS,
    };
    return seed;
  }

  /**
   * Issue #28: handler for /new (and /reset-context alias). Inserts a
   * boundary marker into the persisted history so the NEXT seed-history
   * extraction (when the next provider instance is constructed) drops
   * everything before the marker. Visible chat is untouched — the user
   * can still scroll back to see what they typed.
   *
   * Marker shape:
   *   { role: "system", source: "context-reset", text: "...", ts, sessionId }
   *
   * `source: "context-reset"` is a NEW source value. `filterMessagesForSave`
   * preserves it (only LLM messages of the current session are dropped on
   * save), and `_extractLlmTurnsFromFullHistory` looks for it explicitly.
   */
  _cmdResetContext() {
    const ts = new Date().toISOString();
    const marker = {
      role: "system",
      source: "context-reset",
      text: "── Context cleared — prior conversation stays visible above ──",
      ts,
      sessionId: this.plugin.settings.lastSessionId || null,
    };
    this.messages.push(marker);
    if (Array.isArray(this._fullHistory)) {
      this._fullHistory.push(marker);
    }
    // Render a thin separator so the user sees the boundary in the
    // chat scroll. Distinguished from regular system banners by class
    // so it can be styled as a divider rather than a notice card.
    const sepEl = this.messagesEl.createDiv("gryphon-message gryphon-context-reset");
    sepEl.createEl("span", {
      text: marker.text,
      cls: "gryphon-context-reset-text",
    });
    this._saveChatHistory();
    // Drop any pre-built seed history for the active provider; it will
    // be recomputed on the next send and naturally honor the marker.
    this._pendingSdkHistory = null;
    this.scrollToBottom();
    this._flashStatus(
      "Context cleared for next message — prior conversation stays visible.",
    );
  }

  /**
   * Return (and clear) the pending SDK seed history. One-shot — after
   * the first createProvider consumes it, subsequent calls get [].
   */
  _consumeRestoredLlmHistory() {
    const pending = this._pendingSdkHistory || [];
    this._pendingSdkHistory = null;
    return pending;
  }

  /**
   * Prompt history for terminal-style ArrowUp/Down navigation. Derived
   * from the persisted message log so it survives reloads — the user's
   * "last 50 prompts" stay accessible even after closing Obsidian.
   *
   * Cached per-open to avoid re-scanning messages on every keystroke,
   * but invalidated each time a new user message is sent (in
   * addUserMessage) so freshly sent prompts are immediately recallable.
   */
  /**
   * Remove the auto-injected [gryphon-context]...[/gryphon-context] block
   * from a user-message text. Historically a bug (or older build) may
   * have persisted the full composite — the block + the user's typed
   * text — into chat-history.json. Reading it back would then show the
   * whole composite when the user hit ↑ to recall their prompt. Strip
   * defensively at every read site so old on-disk history stops
   * surfacing the block.
   */
  _stripContextBlock(text) {
    if (typeof text !== "string") return text;
    // Strip ALL leading Gryphon-injected blocks, in any order, until
    // none remain. The augmented prompt currently includes up to four
    // such blocks at the start (context + anti-drift reminder +
    // compound reminder + post-deny clarifier), and a single-pass
    // strip would leak the latter ones into the user-visible bubble
    // and the up-arrow recall. Loop until stable so any future
    // additions are absorbed automatically.
    let prev;
    do {
      prev = text;
      text = text.replace(
        /^\s*\[gryphon-(?:context|reminder)\][\s\S]*?\[\/gryphon-(?:context|reminder)\]\s*/,
        "",
      );
    } while (text !== prev);
    return text;
  }

  /**
   * Derive trigger keywords from the user's active protected-pattern
   * lists PLUS a small hardcoded natural-language verb list. Returns
   * a lowercased Set for case-insensitive `.has()` checks.
   *
   * The natural-language verbs are hardcoded because regex patterns
   * like `\brm\s+\S` don't contain the English word "delete" that a
   * user typically types in their prompt. We need both: pattern-
   * extracted command names (rm, Remove-Item, del, sudo, curl, iex,
   * schtasks, etc.) AND natural-language intent verbs (delete, remove,
   * install, execute, run, etc.).
   *
   * Cached per plugin-settings snapshot; recomputed if the user edits
   * their custom patterns mid-session.
   */
  _buildTriggerKeywords() {
    const snapshotKey = JSON.stringify({
      cmdDisabled: this.plugin.settings.protectedCommandsDisabled || [],
      cmdCustom: this.plugin.settings.protectedCommandsCustom || [],
      pathDisabled: this.plugin.settings.protectedPathsDisabled || [],
      pathCustom: this.plugin.settings.protectedPathsCustom || [],
    });
    if (this._triggerKwCache && this._triggerKwSnapshot === snapshotKey) {
      return this._triggerKwCache;
    }

    // Tokens that appear in detection patterns but must NOT become
    // reminder triggers — they collide with common English prose and
    // would over-fire the reminder on ordinary knowledge-management
    // conversations ("find me the notes about X", "copy that passage
    // into the archive"). Growing the detection rule set must not
    // grow the reminder-trigger set through auto-extraction.
    // See docs/adr/0001-command-classifier-boundary.md.
    const REMINDER_TRIGGER_EXCLUSIONS = new Set([
      "find",       // "find me..." is common prose; detect fires only on `find -delete`
      "copy",       // "copy the quote" is common prose; Copy-Item still detected
      "move",       // "move the note" is common prose
      "item",       // "this item", extracted from Remove-Item/Copy-Item/etc.
      "property",   // "a property of", extracted from Set-ItemProperty
      "content",    // "the content of", extracted from Set-Content/Out-File
      "process",    // "the process of", extracted from Start-Process/New-Process
      "service",    // "the service", extracted from New-Service/sc.exe service
      "expression", // "an expression", extracted from Invoke-Expression
      "request",    // "request X from Y", extracted from Invoke-WebRequest
      "method",     // "the method", extracted from Invoke-RestMethod
      "object",     // "the object", extracted from New-Object Net.WebClient
      "webclient",  // part of "Net.WebClient" — too rare to need, and reminder exists for refusal-wording bias, not detection breadth
    ]);

    const keywords = new Set();

    // Natural-language verbs users tend to type when they want a
    // destructive / privileged / filesystem-mutating operation.
    const NL_VERBS = [
      "delete", "remove", "erase", "wipe", "destroy", "purge", "unlink",
      "execute", "run", "install", "uninstall", "format", "modify",
      "overwrite", "sudo", "admin",
    ];
    for (const v of NL_VERBS) keywords.add(v);

    // Extract command-name keywords from all active protected-command
    // patterns. We want ALL alphanumeric tokens in each regex, not just
    // the first — a pattern like `\|\s*(bash|sh|zsh|fish|tcsh|csh|ksh)`
    // should contribute every shell name it matches, not only "bash".
    // Start-Process -Verb RunAs should contribute both "Start-Process"
    // AND "RunAs" so a user typing "elevate with runas" triggers.
    // _extractKeyword from cc-disallow-translator only returns the
    // first token; we do fuller token extraction here.
    const { DEFAULT_PROTECTED_COMMANDS, DEFAULT_PROTECTED_PATHS } = require("./constants");
    const { resolveActivePatterns } = require("@gryphon/protect");

    const activeCmds = resolveActivePatterns(
      DEFAULT_PROTECTED_COMMANDS,
      this.plugin.settings.protectedCommandsDisabled,
      this.plugin.settings.protectedCommandsCustom,
    );
    for (const p of activeCmds) {
      if (typeof p !== "string") continue;
      // Strip regex metacharacters, then collect every token ≥ 3 chars.
      // The length floor drops things like "sh" that would over-trigger,
      // while keeping "rm", "sc" etc. out of the list (too short to be
      // distinctive in natural text). 3+ chars keeps "iex", "irm",
      // "sudo", "curl" etc., which are all distinctive enough.
      const stripped = p
        .replace(/\\[bBsSwWdD]/g, " ")
        .replace(/[(){}\[\]^$+*?|.\\]/g, " ")
        .replace(/\\\s/g, " ");
      const tokens = stripped.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
      for (const tok of tokens) {
        // Skip regex-metacharacter leftovers ("0,512" → "", "Rrf" → keep).
        if (/^\d/.test(tok)) continue;
        const lower = tok.toLowerCase();
        // Exclusion check: see REMINDER_TRIGGER_EXCLUSIONS above.
        if (REMINDER_TRIGGER_EXCLUSIONS.has(lower)) continue;
        keywords.add(lower);
      }
    }

    // Extract path fragments. We DON'T add the top-level segment
    // (like ".obsidian") as a keyword because that over-fires on
    // any conversational prompt about the user's vault or plugin —
    // "how do I configure this obsidian plugin" would then trigger
    // the reminder on every turn, burning tokens. Only add the full
    // path (entered as-is by the user) and, for deep paths, the
    // more distinctive tail segment.
    const activePaths = resolveActivePatterns(
      DEFAULT_PROTECTED_PATHS,
      this.plugin.settings.protectedPathsDisabled,
      this.plugin.settings.protectedPathsCustom,
    );
    for (const p of activePaths) {
      if (typeof p !== "string") continue;
      const normalized = p.replace(/^\//, "").replace(/\/$/, "");
      if (normalized.length >= 4) {
        keywords.add(normalized.toLowerCase());
      }
      // For deep paths (3+ segments), add the last (most distinctive)
      // segment. Skip shallow paths — ".obsidian" alone over-fires.
      const segments = normalized.split("/").filter(Boolean);
      if (segments.length >= 3) {
        const tail = segments[segments.length - 1];
        if (tail.length >= 4) keywords.add(tail.toLowerCase());
      }
    }

    this._triggerKwCache = keywords;
    this._triggerKwSnapshot = snapshotKey;
    return keywords;
  }

  /**
   * Return the reminder block to inject when a trigger keyword is
   * detected. Kept short (~60 tokens) because it accumulates on every
   * triggered turn. The directive focuses on the single most-observed
   * drift pattern (adding preamble/epilogue to refusal reasons); other
   * directives live in the system prompt and don't need re-emphasis
   * per-turn.
   */
  _buildReminderBlock() {
    return (
      "[gryphon-reminder]\n" +
      "If this request triggers a Gryphon protected-pattern refusal, " +
      "the tool result's `reason` field is the EXACT text to relay. " +
      "Output ONLY that text — no preamble (no \"Gryphon is blocking\", " +
      "\"hook\"), no epilogue (no \"I can't bypass this\"), no " +
      "workaround suggestions (no File Explorer, no Command Prompt, " +
      "no manual delete).\n" +
      "[/gryphon-reminder]\n\n"
    );
  }

  /**
   * Heuristic: does this prompt look like a compound request that
   * includes a destructive sub-task? Used to inject a stronger
   * per-turn reminder when SDK models otherwise silently drop the
   * destructive half of "summarize X and delete Y" — RLHF safety
   * bias makes them skip the rm step even when the system prompt
   * tells them not to. The user already configured Gryphon to
   * decide what's allowed; the model's job is to ATTEMPT every
   * sub-task and let Gryphon answer. A per-turn reminder placed
   * adjacent to the user message moves the directive from
   * "general guidance" (system prompt) to "applies right now"
   * (recency + adjacency lift compliance on smaller models).
   *
   * Detection: keyword-based, case-insensitive. Conservative —
   * false positives just add ~80 tokens, no behavior change. We
   * only trigger when a destructive verb appears AND the prompt
   * has at least one connector ("and", "then", ".", "+", semicolon)
   * suggesting multiple sub-tasks. Single-request prompts ("delete
   * /tmp/x") don't need the compound reminder; the SDK system
   * prompt's single-request rule already handles them.
   */
  _shouldInjectCompoundReminder(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const lower = text.toLowerCase();
    // Destructive verbs that RLHF models commonly skip even when
    // explicitly asked. Word-boundary matched.
    const destructive = /\b(delete|remove|rm|erase|unlink|truncate|drop|destroy|wipe|shred|completely\s+remove)\b/i;
    if (!destructive.test(lower)) return false;
    // Must look like multiple sub-tasks. Connectors that indicate a
    // second clause: "and", "then", ".", ";", "+", "also", "first/second",
    // "after that". We require at least one and at least 30 chars of
    // text (rules out one-word prompts like "delete X.").
    if (text.trim().length < 30) return false;
    const compound = /\b(and|then|also|after\s+that|first|second|next)\b|[.;]\s|[+]/i;
    return compound.test(text);
  }

  /**
   * Per-turn compound-request reminder. Strong, concrete, with the
   * explicit instruction to call the tool. Placed adjacent to the
   * user message (after _buildReminderBlock) so the model parses
   * it as part of "what to do for THIS request" rather than as
   * abstract guidance.
   */
  _buildCompoundReminderBlock() {
    return (
      "[gryphon-reminder]\n" +
      "Your message contains MULTIPLE sub-tasks; one looks " +
      "destructive (delete / remove / rm / drop / etc.). You MUST " +
      "attempt every sub-task by calling the appropriate tool — do " +
      "NOT skip the destructive one because it \"sounds dangerous\". " +
      "The user has already configured Gryphon's protected patterns; " +
      "Gryphon will refuse the operation and return a `reason` field " +
      "if it's blocked, or run it if it's allowed. Either outcome is " +
      "correct. What is INCORRECT is silently dropping the sub-task " +
      "and answering only the safe part. Final reply shape: <safe " +
      "answer>\\n\\n<reason verbatim from refused tool result>.\n" +
      "[/gryphon-reminder]\n\n"
    );
  }

  /**
   * Post-deny clarifier reminder. Fires on the turn IMMEDIATELY
   * AFTER a turn that ended with a Gryphon protected-pattern
   * refusal. The aim: counter the model's "I already did this; this
   * must be a system-only repeat" inference that surfaces on
   * long-running CC processes when the prior turn ended in a deny
   * (observed: Claude Code on Linux, attempt 2 of "summarize and
   * delete X" responded with "your message came through empty").
   *
   * Why a per-turn reminder (vs killing the CC process):
   *   - Kill+respawn would lose all conversation context — bad UX
   *     for multi-turn work where only the LATEST sub-task got
   *     refused.
   *   - String-match on user prompt would miss valid variations
   *     ("rm X" vs "delete X" vs "remove X" — same intent).
   *   - This reminder triggers on the actual prior OUTCOME (the
   *     deny was emitted to the user), not on prompt wording.
   *
   * One-shot — fires only on the very next turn, then the trigger
   * flag clears. Doesn't accumulate or repeat across multiple turns
   * after a single deny.
   */
  _buildPostDenyClarifierBlock() {
    return (
      "[gryphon-reminder]\n" +
      "Your previous turn ended with a Gryphon protected-pattern " +
      "refusal of a tool call. That refusal applied ONLY to that " +
      "prior attempt. For THIS turn, treat the user's new message " +
      "as a fresh, real, non-empty user request — process it fully " +
      "on its own merits. The text after this reminder block IS " +
      "the user's message, not a system notification, not an empty " +
      "frame, not a repeat-noise artifact, not metadata. Attempt " +
      "every tool call the user implies, including destructive " +
      "ones; Gryphon will respond per the user's CURRENT " +
      "protected-pattern settings (which the user may have changed " +
      "between turns). Do NOT assume the prior refusal carries " +
      "over. " +
      "FORBIDDEN ANSWER SHAPES (any phrasing of these is wrong; " +
      "the user has explicitly asked for content):\n" +
      "  - \"Your message came through empty\"\n" +
      "  - \"Your message appears to be empty\"\n" +
      "  - \"It looks like your message came through empty\"\n" +
      "  - \"just a system notification came through\"\n" +
      "  - \"this looks like a system notification\"\n" +
      "  - \"What can I help you with?\" (when the user already " +
      "    asked something)\n" +
      "  - any phrasing that says nothing arrived / nothing was " +
      "    sent / the message was blank / the message was just " +
      "    metadata.\n" +
      "If you are about to write any of those, STOP and re-read " +
      "the actual user text below this block — it is real, " +
      "non-empty, and you must engage with it.\n" +
      "[/gryphon-reminder]\n\n"
    );
  }

  /**
   * Set when the just-finalized assistant turn contained the
   * canonical Gryphon protected-deny marker. Read by the next send
   * to decide whether to inject the post-deny clarifier reminder.
   * One-shot — _maybeInjectPostDenyClarifier clears it after firing.
   */
  _markPriorTurnDenyIfPresent(text) {
    if (typeof text !== "string" || text.length === 0) return;
    const marker = "matches one of your protected patterns in Gryphon";
    if (text.includes(marker)) {
      this._priorTurnHadProtectedDeny = true;
    }
  }

  /**
   * One-shot accessor — returns the post-deny clarifier block when
   * the flag is set, else empty string. Clears the flag in either
   * branch (one shot).
   */
  _consumePostDenyClarifier() {
    if (!this._priorTurnHadProtectedDeny) return "";
    this._priorTurnHadProtectedDeny = false;
    return this._buildPostDenyClarifierBlock();
  }

  /**
   * Returns true if the user's text contains any trigger keyword.
   * Case-insensitive substring match (word-boundary not enforced —
   * trigger words in compound text like "protectedCommand" would fire
   * too, which is acceptable since false positives only cost ~60
   * tokens and don't change behaviour).
   */
  _shouldInjectReminder(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const lower = text.toLowerCase();
    const kws = this._buildTriggerKeywords();
    for (const kw of kws) {
      if (kw.length < 3) continue;
      // Word-boundary match so "run" doesn't fire on "running",
      // "truncate", "rundown"; "admin" doesn't fire on "administrator"
      // or "admin-panel" (though those would still fire legitimately
      // because we'd want the reminder for admin-panel-related
      // prompts — but the word-boundary check correctly doesn't fire
      // on mere substrings of unrelated words). Regex escape the
      // keyword in case it contains regex metacharacters (paths can
      // contain `.`).
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(lower)) return true;
    }
    return false;
  }

  _getPromptHistory() {
    // Only honor the cache when it actually contains prompts. The
    // earlier `if (this._cachedPromptHistory)` truthy check accepted
    // an empty array (`[]` is truthy in JS), so a build that ran
    // before any user prompts existed — or before this.messages was
    // fully populated from _restoreChatHistory — would cache `[]` and
    // every subsequent ArrowUp would silently return that empty
    // result. Not caching empty arrays costs one rebuild per empty
    // check (cheap — we're iterating in-memory arrays) and fixes the
    // "up-arrow does nothing until I press down-then-up" symptom.
    if (Array.isArray(this._cachedPromptHistory) &&
        this._cachedPromptHistory.length > 0) {
      return this._cachedPromptHistory;
    }
    const MAX = 100;

    // Two sources that each see a different slice of reality:
    //   _fullHistory — load-time snapshot of persisted chat-history.json.
    //                  Covers everything up to and including the last save
    //                  before this session opened. Never updated after
    //                  load, so it misses anything typed this session.
    //   this.messages — live list. Contains the most recent batch loaded
    //                  from _fullHistory plus every new message sent this
    //                  session.
    // Neither alone is complete: _fullHistory misses current-session
    // prompts; this.messages misses persisted prompts older than the
    // initial batch (_historyLoadedUpTo). Merge both, dedupe by ts.
    const merged = new Map();
    for (const m of (this._fullHistory || [])) {
      if (m.ts) merged.set(m.ts, m);
    }
    for (const m of (this.messages || [])) {
      if (m.ts) merged.set(m.ts, m);  // session wins on collision
    }
    const ordered = [...merged.values()].sort((a, b) =>
      (a.ts || "").localeCompare(b.ts || "")
    );

    const prompts = [];
    for (const m of ordered) {
      if (m.role !== "user") continue;
      if (!m.text || !m.text.trim()) continue;
      // Skip mechanical-source messages (domain-specific commands a
      // consuming plugin logs) that aren't user prompts users want to
      // re-navigate to.
      if (m.source && m.source !== "llm") continue;
      // Strip any auto-injected [gryphon-context] prefix (see method
      // doc above). If the entire text was the context block, skip.
      const clean = this._stripContextBlock(m.text).trim();
      if (!clean) continue;
      // No deduplication — matches bash/zsh/fish defaults. Earlier
      // versions collapsed consecutive-identical prompts into one,
      // but from the user's perspective 10 deliberate sends of the
      // same text are 10 separate actions and ArrowUp should walk
      // through each. The prior dedup also hid repeats that had
      // assistant responses or system notices between them, because
      // those are filtered out before this check — making the
      // behavior surprising whenever a user deliberately re-sent the
      // same question. If a future caller wants dedup behavior, add
      // it as an opt-in setting rather than bake it in here.
      prompts.push(clean);
    }
    // Append queued-but-not-yet-fired prompts so up-arrow recall sees
    // them too. Lifecycle: pushed in `_enqueuePrompt`, removed in
    // `_drainQueuedPrompts` once the prompt fires (so the post-send
    // entry from `addUserMessage` doesn't duplicate). Survives
    // `_clearQueuedPrompts` (stop/timeout/error) so the user can
    // recover queued text that never got a chance to fire.
    if (Array.isArray(this._pendingQueuedTexts) && this._pendingQueuedTexts.length > 0) {
      for (const t of this._pendingQueuedTexts) {
        if (typeof t === "string" && t.trim()) prompts.push(t);
      }
    }
    this._cachedPromptHistory = prompts.slice(-MAX);
    return this._cachedPromptHistory;
  }

  _invalidatePromptHistoryCache() {
    this._cachedPromptHistory = null;
  }

  _setInputFromHistory(text) {
    this.inputEl.value = text;
    // Auto-resize to fit recalled prompt (same logic as the input handler)
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
    // Place cursor at end — standard terminal behavior
    this.inputEl.selectionStart = this.inputEl.selectionEnd = text.length;
    this.inputEl.focus();
    // Keep autocomplete hidden during history navigation — the
    // per-keystroke listener also clears _promptHistoryIdx, which we
    // don't want happening here.
    this._hideAutocomplete();
  }

  _chatHistoryPath() {
    return path.join(
      this.app.vault.adapter.basePath,
      ".obsidian", "plugins", this.plugin.manifest.id, "chat-history.json"
    );
  }


  /**
   * Persist local-only messages (plugin-authored — slash commands, system
   * notices) to chat-history.json. The local CLI owns LLM turns in its
   * own .jsonl session file; we don't duplicate them here.
   *
   * Async + atomic: writes to a temp file, renames on success. A crash
   * mid-write leaves the original file intact. Non-blocking: callers can
   * fire-and-forget without stalling the UI.
   *
   * On failure we flash the status bar ONCE (tracking via
   * `_chatHistorySaveError`) — hammering the user on every message event
   * isn't useful, and the first notification is enough for them to notice
   * and check disk space or permissions.
   *
   * @returns {Promise<boolean>} true on success, false on failure
   */
  /**
   * Public entry. Serializes via a promise chain so concurrent callers
   * queue up instead of racing on the shared tmp file. Rapid bursts
   * (e.g. clip processing fires addSystemMessage + finalizeStreamingMessage
   * within milliseconds) used to clobber each other's tmp files, causing
   * "ENOENT on rename" on the loser and occasional history corruption.
   * The chain drops upstream failures so one bad save doesn't stall all
   * future ones.
   */
  async _saveChatHistory() {
    const prev = this._saveQueue || Promise.resolve();
    this._saveQueue = prev
      .catch(() => {})
      .then(() => this._doSaveChatHistory());
    return this._saveQueue;
  }

  async _doSaveChatHistory() {
    // Save filter is per-message-session, not global. Previously the
    // logic was "if the user is in Claude Code mode with a live session, drop
    // ALL LLM messages on the assumption they're all mirrored in CC's
    // jsonl." That assumption breaks across provider changes: a
    // session history built in Anthropic API mode and then continued in CLI
    // would lose the SDK-era turns on the first CLI save (they were
    // never in any jsonl, so dropping them here meant deleting them).
    //
    // New invariant: each message carries a `sessionId` tag set at
    // creation time. We only suppress LLM messages that belong to
    // the current CLI session — those are safely reconstructed from
    // CC's jsonl on load. Messages from a prior SDK session, a
    // compacted CLI session, or any legacy message with no sessionId
    // tag always survive to chat-history.json.
    const filtered = filterMessagesForSave(
      this.messages,
      this.plugin.settings.lastSessionId,
    );
    // Defense-in-depth: regardless of how a user message ended up in
    // `this.messages`, the persisted form must never include the auto-
    // injected [gryphon-context] / [gryphon-reminder] composite. The load
    // path strips both sources, but a bug in any future write site would
    // re-introduce the leak silently. Strip here as the last gate before
    // bytes hit disk. `filter()` returns a new array with the original
    // element references; clone any user message we need to rewrite so we
    // don't mutate the live in-memory chat view. See issue #35.
    const persistable = filtered.map((m) => {
      if (m && m.role === "user" && typeof m.text === "string") {
        const clean = this._stripContextBlock(m.text);
        if (clean !== m.text) return { ...m, text: clean };
      }
      return m;
    });
    const realPath = this._chatHistoryPath();
    // Per-call tmp suffix — defense-in-depth against tmp-path collisions
    // across views or processes. The save chain already serializes within
    // a view; unique tmp guards against cross-view or cross-plugin contention.
    const tmpPath = `${realPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // Defensively ensure the plugin directory exists. Obsidian normally
      // creates it, but during plugin disable/enable cycles or first-run
      // races the directory can briefly be absent — a pending save that
      // fires in that window would otherwise ENOENT.
      await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(persistable));
      await fs.promises.rename(tmpPath, realPath);
      // Clear the "already warned" flag so future failures re-notify.
      this._chatHistorySaveError = null;
      return true;
    } catch (e) {
      console.error("[gryphon] chat history save failed:", e.message);
      if (this._chatHistorySaveError !== e.message) {
        this._chatHistorySaveError = e.message;
        this._flashStatus(`Chat history save failed: ${e.message}`);
      }
      // Best-effort cleanup of the partial temp file.
      fs.promises.unlink(tmpPath).catch(() => {});
      return false;
    }
  }

  /**
   * Load and merge history from both sources, sorted by timestamp.
   *
   * Source 1 (chat-history.json) is plugin-owned: we detect corruption
   * (non-empty file that fails to parse) and move it aside to a timestamped
   * backup so the user can recover manually. `_pendingLoadWarning` is set
   * so `onOpen` can surface the problem via the status bar once
   * `toolbarStatus` is ready.
   *
   * Source 2 (local CLI .jsonl) is CLI-owned: if it's corrupt or missing,
   * we log-and-continue but do NOT rename — that file belongs to the CLI.
   */
  _loadChatHistory() {
    const merged = [];
    const localPath = this._chatHistoryPath();

    // Source 1: plugin-owned local messages.
    try {
      if (fs.existsSync(localPath)) {
        const data = fs.readFileSync(localPath, "utf8");
        if (data.trim()) {
          try {
            const parsed = JSON.parse(data);
            // One-shot in-place migration: if any persisted user message
            // still carries a literal [gryphon-context] / [gryphon-reminder]
            // wrapper from older builds (or from a session-id rotation that
            // copied a CC composite into chat-history.json), strip it now and
            // write the cleaned form back to disk so the leak heals on the
            // first load after upgrade. Best-effort — if the write-back
            // fails the in-memory copy is still clean and the next save
            // will heal the file naturally. See issue #35.
            let migrated = false;
            for (const m of parsed) {
              if (!m.ts) m.ts = "2000-01-01T00:00:00Z"; // backward compat
              if (m.role === "user" && typeof m.text === "string") {
                const clean = this._stripContextBlock(m.text);
                if (clean !== m.text) {
                  m.text = clean;
                  migrated = true;
                }
              }
              merged.push(m);
            }
            if (migrated) {
              try {
                const tmpPath = `${localPath}.tmp-${process.pid}-${Date.now()}-migrate`;
                fs.writeFileSync(tmpPath, JSON.stringify(parsed));
                fs.renameSync(tmpPath, localPath);
                console.warn(
                  "[gryphon] chat-history.json migrated: stripped [gryphon-context] from existing user messages (issue #35)",
                );
              } catch (e) {
                console.warn(
                  `[gryphon] chat-history.json migrate write-back failed: ${e.message}`,
                );
              }
            }
          } catch (parseErr) {
            // Corrupted non-empty file — preserve for user inspection.
            const backup = `${localPath}.bak-${Date.now()}`;
            try {
              fs.renameSync(localPath, backup);
              console.warn(`[gryphon] chat-history.json corrupted; moved to ${backup}`);
              this._pendingLoadWarning =
                `Chat history was corrupted and moved to ${path.basename(backup)} — starting fresh.`;
            } catch (renameErr) {
              console.warn(`[gryphon] could not rename corrupted chat-history.json: ${renameErr.message}`);
              this._pendingLoadWarning =
                `Chat history corrupted and could not be backed up: ${renameErr.message}`;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[gryphon] chat-history.json read error: ${e.message}`);
      this._pendingLoadWarning = `Chat history load failed: ${e.message}`;
    }

    // Source 2: local CLI session file (CLI-owned; read-only for us).
    //
    // Only relevant when the current provider preference uses the CLI
    // ("claude-code" or "auto"). Otherwise `lastSessionId` may point at
    // a stale CLI session — e.g. the user switched providers from
    // claude-code to anthropic-api but the old CLI session jsonl is
    // still on disk. Reading it would replay old CLI messages that the
    // SDK has since persisted again into chat-history.json, producing
    // duplicates on every reload. Defensive: also skip if the session
    // id is SDK-shaped (`sdk-…`), even if a file with that name somehow
    // exists.
    const sessionId = this.plugin.settings.lastSessionId;
    const providerPref = this.plugin.settings.providerPreference || "auto";
    const cliProviderActive = providerPref === "claude-code" || providerPref === "auto";
    const sessionIsSdkShaped = sessionId && String(sessionId).startsWith("sdk-");
    if (sessionId && cliProviderActive && !sessionIsSdkShaped) {
      try {
        const cwd = this.app.vault.adapter.basePath;
        // CC escapes path separators and Windows drive-colons to `-`
        // when computing the per-project subdir name. On POSIX only `/`
        // matters. On Windows `C:\Users\User\vault` becomes
        // `C--Users-User-vault` (both the `:` and every `\` go to `-`,
        // with the adjacent `:\` producing `--`). The previous regex
        // `/\//g` matched nothing on a native Windows path — every
        // reload looked for CC's session file at a non-existent path,
        // found nothing, and silently dropped LLM history from the
        // restore. Cover all three separators in one pass.
        const escaped = cwd.replace(/[\\/:]/g, "-");
        const sessionFile = path.join(os.homedir(), ".claude", "projects", escaped, sessionId + ".jsonl");
        if (fs.existsSync(sessionFile)) {
          const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              const ts = d.timestamp || "2000-01-01T00:00:00Z";
              // User messages. Tagged with `sessionId` so the next
              // _doSaveChatHistory correctly drops them (they'll
              // re-appear from this same jsonl on the next load).
              // Without the tag, the save treats them as untagged
              // legacy messages and persists them to chat-history.json,
              // where they'd duplicate on the next reload.
              if (d.type === "queue-operation" && d.operation === "enqueue" && d.content) {
                // Strip the auto-injected [gryphon-context] / [gryphon-reminder]
                // composite that Gryphon sent to CC. CC persists what it
                // receives, so the raw jsonl content includes the wrapper —
                // re-rendering it in the user bubble is the issue #35 leak.
                merged.push({
                  role: "user",
                  text: this._stripContextBlock(d.content),
                  ts,
                  source: "llm",
                  sessionId,
                });
              }
              // Assistant messages (text + thinking blocks). Same
              // sessionId tag for the same reason. Issue #4: preserve
              // thinking blocks across CC-session reloads so the
              // collapsed-disclosure affordance survives Obsidian
              // restart for CC turns the way it does for SDK turns.
              if (d.message && d.message.role === "assistant" && Array.isArray(d.message.content)) {
                let textBlock = null;
                const thinkingBlocks = [];
                for (const block of d.message.content) {
                  if (block.type === "text" && block.text && !textBlock) {
                    textBlock = block.text;
                  } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
                    thinkingBlocks.push(block.thinking);
                  } else if (block.type === "redacted_thinking") {
                    thinkingBlocks.push("[redacted thinking]");
                  }
                }
                if (textBlock) {
                  const entry = { role: "assistant", text: textBlock, ts, source: "llm", sessionId };
                  if (thinkingBlocks.length > 0) entry.thinking = thinkingBlocks;
                  merged.push(entry);
                }
              }
            } catch {
              // Skip malformed line; continue — CC owns this file.
            }
          }
        }
      } catch (e) {
        console.warn(`[gryphon] CC session file read error: ${e.message}`);
      }
    }

    merged.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));

    // Issue #36 follow-on: dedupe user prompts that appear in BOTH
    // sources (chat-history.json + CC's jsonl). The new `failed: true`
    // fix keeps aborted prompts in chat-history.json — but if CC also
    // received the prompt before timing out, jsonl has it too. Naive
    // merge would render both as separate user bubbles. Dedupe by
    // (role=user, source=llm, exact text) within a 10-second window;
    // prefer the chat-history.json entry (it carries the `failed`
    // flag, which the CLI jsonl entry doesn't, and we want that flag
    // to round-trip across reloads so future saves keep preserving
    // the prompt).
    const seenUserKeys = new Map(); // text → { idx, ts }
    const dedup = [];
    for (const m of merged) {
      if (m && m.role === "user" && m.source === "llm" && typeof m.text === "string") {
        const ts = Date.parse(m.ts) || 0;
        const prior = seenUserKeys.get(m.text);
        if (prior && Math.abs(ts - prior.ts) < 10_000) {
          // Same prompt, within 10s. Keep the one with `failed`
          // tagged (preserves the marker across reloads); else keep
          // the first-seen.
          if (m.failed && !dedup[prior.idx].failed) {
            dedup[prior.idx] = m;
          }
          continue;
        }
        seenUserKeys.set(m.text, { idx: dedup.length, ts });
      }
      dedup.push(m);
    }
    return dedup;
  }

  /**
   * Issue #4: render extended-reasoning ("thinking") output as a
   * collapsed <details> disclosure inside the assistant bubble. Multiple
   * thinking blocks per turn are joined with horizontal rules so they
   * stay distinguishable when expanded. Blocks display as plain text
   * (preserving newlines) — they're internal model output, not markdown
   * authored for rendering.
   *
   * @param {HTMLElement} bubbleEl       — the .gryphon-bubble-assistant element
   * @param {string[]} thinking          — non-empty thinking strings
   * @param {HTMLElement} [insertBefore] — if provided, insert the disclosure
   *                                       before this child (so the thinking
   *                                       block sits ABOVE the response text)
   */
  _renderThinkingBlock(bubbleEl, thinking, insertBefore = null) {
    const details = document.createElement("details");
    details.className = "gryphon-thinking";
    const summary = document.createElement("summary");
    summary.className = "gryphon-thinking-summary";
    summary.textContent = thinking.length > 1
      ? `\u{1F4AD} Thinking (${thinking.length} blocks)`
      : "\u{1F4AD} Thinking";
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "gryphon-thinking-body";
    for (let i = 0; i < thinking.length; i++) {
      if (i > 0) body.appendChild(document.createElement("hr"));
      const pre = document.createElement("pre");
      pre.className = "gryphon-thinking-text";
      pre.textContent = thinking[i];
      body.appendChild(pre);
    }
    details.appendChild(body);
    if (insertBefore && insertBefore.parentElement === bubbleEl) {
      bubbleEl.insertBefore(details, insertBefore);
    } else {
      bubbleEl.appendChild(details);
    }
  }

  _renderMessage(msg) {
    if (msg.role === "user") {
      const msgEl = document.createElement("div");
      msgEl.className = msg.sideNote
        ? "gryphon-message gryphon-user gryphon-sidenote"
        : "gryphon-message gryphon-user";
      const bubble = msgEl.createDiv(msg.sideNote
        ? "gryphon-bubble gryphon-bubble-user gryphon-bubble-sidenote"
        : "gryphon-bubble gryphon-bubble-user");
      // Plain `>` for the prompt prefix \u2014 universally supported by
      // every font on every platform. The earlier `\u276F` (HEAVY
      // RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT, \u276F) lives in
      // the Unicode Dingbats block and isn't covered by many default
      // Linux Obsidian font stacks; it rendered as a missing-glyph
      // box / blank space on those systems. User report 2026-05-04
      // (Linux Claude Code: "the current Linux version doesn't have
      // [the > prefix]"). ASCII `>` round-trips through every font.
      bubble.createEl("span", { text: "> ", cls: "gryphon-prompt-prefix" });
      // Defense-in-depth render-time strip: ANY persisted composite that
      // slipped past the load/save/migrate gates (e.g. a chat-history.json
      // entry from a session that ran before the migration shipped, OR a
      // consumer-side wrapper that pushed already-augmented text into
      // `this.messages` directly) renders clean here. The strip is idem-
      // potent on already-clean text. See issue #35 \u2014 a downstream
      // consumer-vendor user reported the leak still appearing in their
      // session even after the load/save fix; this render-layer strip
      // closes the residual path independently of any caller's discipline.
      const renderText = this._stripContextBlock(msg.text);
      bubble.createEl("span", { text: renderText, cls: "gryphon-text" });
      if (msg.sideNote) {
        bubble.createEl("span", { text: " \u00B7 btw", cls: "gryphon-sidenote-tag" });
      }
      return msgEl;
    } else if (msg.role === "assistant") {
      const msgEl = document.createElement("div");
      msgEl.className = "gryphon-message gryphon-assistant";
      const bubble = msgEl.createDiv("gryphon-bubble gryphon-bubble-assistant");
      // Issue #4: render persisted thinking blocks above the assistant
      // text so they survive reload + Obsidian restart with the same
      // collapsed-by-default affordance as freshly streamed turns.
      if (Array.isArray(msg.thinking) && msg.thinking.length > 0) {
        this._renderThinkingBlock(bubble, msg.thinking);
      }
      const contentEl = bubble.createDiv("gryphon-text");
      MarkdownRenderer.render(this.app, msg.text, contentEl, "", this.plugin);
      return msgEl;
    } else if (msg.role === "system") {
      const msgEl = document.createElement("div");
      // Issue #28: context-reset markers render as a thin divider, not
      // a system notice card. Distinguished by the source field so the
      // CSS class can style them as a horizontal separator.
      const isReset = msg.source === "context-reset";
      msgEl.className = isReset
        ? "gryphon-message gryphon-context-reset"
        : "gryphon-message gryphon-system";
      msgEl.createEl("span", {
        text: msg.text,
        cls: isReset ? "gryphon-context-reset-text" : "gryphon-system-text",
      });
      return msgEl;
    }
    return null;
  }

  _restoreChatHistory() {
    this._fullHistory = this._loadChatHistory();

    // Capture LLM turns from loaded history so Anthropic API mode can seed its
    // provider on first send. Stored as a one-shot buffer — consumed the
    // next time createProvider runs, then cleared. Claude Code mode ignores this
    // (it uses CC's --resume via lastSessionId).
    this._pendingSdkHistory = this._extractLlmTurnsFromFullHistory();

    if (this._fullHistory.length === 0) return;

    // `this.messages` is the canonical in-memory mirror of persisted
    // history. `_saveChatHistory` writes from it, so it must hold
    // EVERY entry — not just the last 30 we render in the DOM. An
    // earlier version stored only the rendered tail here; any save
    // that followed then truncated the on-disk file to just that tail,
    // progressively eroding older messages over time (see CHANGELOG
    // v0.5.9). Keep the full history here; use `_historyLoadedUpTo`
    // as a pure UI/DOM cursor, independent of the data-side array.
    this.messages = [...this._fullHistory];

    const BATCH = 30;
    this._historyLoadedUpTo = Math.max(0, this._fullHistory.length - BATCH);
    const initial = this._fullHistory.slice(this._historyLoadedUpTo);

    for (const msg of initial) {
      const el = this._renderMessage(msg);
      if (el) this.messagesEl.appendChild(el);
    }

    this._ensureLoadMoreHint();

    this.messagesEl.addEventListener("scroll", () => {
      if (this.messagesEl.scrollTop < 50 && this._historyLoadedUpTo > 0) {
        this._loadOlderMessages();
      }
    });

    this.scrollToBottom();
  }

  /**
   * Render the "scroll up for N earlier messages" hint at the top of the
   * messages pane, or remove it when no earlier messages remain. Called
   * after initial restore and after each `_loadOlderMessages` batch.
   */
  _ensureLoadMoreHint() {
    if (this._loadMoreHint) {
      this._loadMoreHint.remove();
      this._loadMoreHint = null;
    }
    if (!this._historyLoadedUpTo || this._historyLoadedUpTo <= 0) return;
    this._loadMoreHint = document.createElement("div");
    this._loadMoreHint.className = "gryphon-system";
    const span = document.createElement("span");
    span.className = "gryphon-system-text";
    span.textContent = `\u2191 scroll up for ${this._historyLoadedUpTo} earlier messages`;
    this._loadMoreHint.appendChild(span);
    this.messagesEl.prepend(this._loadMoreHint);
  }

  _loadOlderMessages() {
    if (!this._fullHistory || this._historyLoadedUpTo <= 0) return;

    const BATCH = 30;
    const start = Math.max(0, this._historyLoadedUpTo - BATCH);
    const batch = this._fullHistory.slice(start, this._historyLoadedUpTo);
    this._historyLoadedUpTo = start;

    const prevHeight = this.messagesEl.scrollHeight;

    // `_ensureLoadMoreHint` removes the old hint; we re-create it below if
    // `_historyLoadedUpTo` is still > 0 after prepending this batch.
    if (this._loadMoreHint) {
      this._loadMoreHint.remove();
      this._loadMoreHint = null;
    }

    const firstChild = this.messagesEl.firstChild;
    for (const msg of batch) {
      const el = this._renderMessage(msg);
      if (el) this.messagesEl.insertBefore(el, firstChild);
    }
    // Note: this.messages is the full history already (see
    // _restoreChatHistory); we don't mutate it here. _historyLoadedUpTo
    // is the only thing that changes — it's a DOM-render cursor, not a
    // data-state cursor. Pre-v0.5.9 we prepended here too, which
    // duplicated entries each time the user scrolled up.

    this._ensureLoadMoreHint();

    const newHeight = this.messagesEl.scrollHeight;
    this.messagesEl.scrollTop = newHeight - prevHeight;
  }

  /**
   * Returns " (est.)" when the active provider reports its cost as
   * locally-computed (Anthropic API mode) rather than server-attested (Claude Code mode).
   * Used by /cost and /usage so SDK users don't mistake the displayed
   * number for an authoritative invoice line.
   *
   * Returns "" if no provider exists yet (fresh session) — there's no
   * cost to qualify in that case.
   */
  _costSuffix() {
    if (!this.claudeProcess) return "";
    return this.claudeProcess.costIsEstimate ? " (est.)" : "";
  }

  /**
   * Surface skill-load errors from the registry as a chat system message
   * so users see "X skill files failed to load — check console" rather
   * than wondering why /tag-suggest stopped autocompleting. The full
   * per-file message is in the browser console.
   */
  _surfaceSkillLoadErrors() {
    const reg = this.plugin.skillRegistry;
    if (!reg || typeof reg.getErrors !== "function") return;
    const errors = reg.getErrors();
    if (errors.length === 0) return;
    const list = errors.map((e) => `  • ${e.path}`).join("\n");
    this.addSystemMessage(
      `${errors.length} skill file${errors.length === 1 ? "" : "s"} failed to load:\n${list}\n` +
      `(check the developer console with Cmd+Opt+I for the parse error on each)`
    );
  }

  // ── Onboarding ──

  /**
   * If the user opens Gryphon with no provider available, show a guided
   * setup panel inside the message area instead of letting them type a
   * prompt and hit a useless "no provider available" error on send.
   *
   * The two cards adapt to runtime detection:
   *   - CLI binary detected → one-click "Use local CLI" (sets
   *     providerPreference = "cli"), with terms-compliance disclaimer
   *   - API key found (settings field or env var) → one-click "Use
   *     Anthropic API" (sets providerPreference = "sdk")
   *   - Neither detected → setup instructions on the SDK card;
   *     the CLI card points at the SDK path instead of install-promoting
   *
   * The panel is dismissible, and `refreshWelcomePanel()` lets settings
   * changes hide it without requiring a reload.
   */
  _renderWelcomePanelIfNeeded() {
    const provider = createProvider(
      this.plugin,
      this.app.vault.adapter.basePath,
      {}
    );
    if (provider) return;  // a provider can resolve — nothing to show

    // Bug #23 fix: skip the welcome panel when the user already has
    // chat history. Otherwise the welcome panel is appended AFTER
    // _restoreChatHistory called scrollToBottom (which uses RAF, so
    // it reads scrollHeight in the next frame — by which time the
    // welcome panel exists and dominates the bottom). Result was:
    // user sees only the welcome panel, their actual chat is
    // scrolled out of view above. The user already has all the
    // setup context they need from the inline `explainUnavailable`
    // bubble that fires on a failed send (in `sendMessage`'s
    // createProvider-null branch); the welcome-panel onboarding is
    // for first-time users with an empty chat.
    if (this.messages && this.messages.length > 0) return;

    const detected = detectAvailable(this.plugin);
    const panel = this.messagesEl.createDiv("gryphon-welcome");
    this._welcomePanelEl = panel;

    panel.createEl("h2", { text: "Welcome to Gryphon" });
    panel.createEl("p", {
      text:
        "Gryphon connects Obsidian to Claude — read and edit your vault, " +
        "run tools, and chat with your knowledge base. Pick a provider to begin.",
    });
    // Surface the built-in security positioning above the cards. New
    // users coming from other Claude-for-Obsidian plugins won't know
    // about Gryphon's protected-pattern modal layer otherwise; the
    // welcome panel is the right moment to set the expectation.
    const secLine = panel.createEl("p", { cls: "gryphon-welcome-security" });
    secLine.createSpan({
      text: "Built-in security: dangerous file paths and shell commands " +
        "(rm -rf, writes into .obsidian/, curl | bash, etc.) always prompt " +
        "before running — even in YOLO mode. ",
    });
    secLine.createEl("strong", { text: "Tune the rules in Settings → Gryphon → Security." });

    const cards = panel.createDiv("gryphon-welcome-cards");
    // Render the recommended (SDK) card first so it gets primary
    // attention; CLI follows as the advanced option.
    this._renderSdkCard(cards, detected);
    this._renderCliCard(cards, detected);

    // Manual hint at the bottom — discoverable pointer to the in-vault
    // user manual, so first-time users know where to look beyond setup.
    const manualHint = panel.createEl("p", { cls: "gryphon-welcome-manual" });
    manualHint.createSpan({ text: "New here? See the user manual at " });
    const manualLink = manualHint.createEl("a", {
      text: "Gryphon/MANUAL.md",
      href: "#",
    });
    manualLink.addEventListener("click", (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText("Gryphon/MANUAL", "");
    });
    manualHint.createSpan({
      text: " in your vault for slash commands, permission modes, skills, and troubleshooting.",
    });

    const dismiss = panel.createEl("a", {
      text: "Dismiss",
      cls: "gryphon-welcome-dismiss",
    });
    dismiss.addEventListener("click", (e) => {
      e.preventDefault();
      this.refreshWelcomePanel(/*forceHide=*/true);
    });
  }

  /**
   * Card for the local-CLI path. If a `claude` binary is detected
   * (settings override or auto-discovery), the card offers a one-click
   * switch. Otherwise the card hints that Claude Code is the advanced
   * option and recommends the Anthropic API card instead — we don't
   * install-promote Claude Code, because its licensing terms are
   * its vendor's to communicate.
   */
  _renderCliCard(parent, detected) {
    const card = parent.createDiv("gryphon-welcome-card");
    card.createEl("h3", { text: "Claude Code (advanced)" });

    if (detected.cliPath) {
      const { displayPath } = require("@gryphon/provider-runtime");
      card.createEl("p", {
        text:
          `A \`claude\` binary was detected at ${displayPath(detected.cliPath)}. Switching ` +
          `to Claude Code mode spawns it as a subprocess. Before enabling, ` +
          `confirm your intended usage complies with that product's terms — ` +
          `Gryphon is not affiliated with Anthropic.`,
      });
      const btn = card.createEl("button", {
        text: "Use Claude Code",
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => this._activateProvider("claude-code"));
    } else {
      card.createEl("p", {
        text:
          "No local `claude` binary detected. Claude Code is an advanced " +
          "option for users who already have that product installed and " +
          "have confirmed their usage complies with its vendor's terms. " +
          "Most users should use the Anthropic API card instead.",
      });
    }
  }

  /**
   * Card for the Anthropic API (SDK) path. Recommended for most users.
   * If a key is found anywhere (settings field or env var), the card
   * offers a one-click switch. Otherwise it points the user at the
   * settings tab to paste a key.
   */
  _renderSdkCard(parent, detected) {
    const card = parent.createDiv("gryphon-welcome-card");
    card.createEl("h3", { text: "Anthropic API (recommended)" });

    if (detected.apiKey) {
      const sourceLabel = detected.apiKeySource === "env"
        ? "API key found in $ANTHROPIC_API_KEY environment variable."
        : "API key configured in settings.";
      card.createEl("p", {
        text: `${sourceLabel} Switch your provider to use it.`,
      });
      const btn = card.createEl("button", {
        text: "Use Anthropic API",
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => this._activateProvider("anthropic-api"));
    } else {
      card.createEl("p", {
        text:
          "Paste an Anthropic API key in settings. Adds credit-based usage " +
          "independent of any subscription. Free tier: $5 of credits at signup.",
      });
      const btn = card.createEl("button", {
        text: "Open settings",
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => {
        const setting = this.app.setting;
        if (setting && setting.open && setting.openTabById) {
          setting.open();
          setting.openTabById(this.plugin.manifest.id);
        }
      });
    }
  }

  /**
   * Activate a provider in one click from the welcome panel: persist the
   * preference, run the same reset hook a settings change would, and
   * refresh the panel so it disappears once a provider can resolve.
   */
  async _activateProvider(preference) {
    const prev = this.plugin.settings.providerPreference || "auto";
    this.plugin.settings.providerPreference = preference;
    await this.plugin.saveSettings();
    this.plugin._resetActiveSessions();
    if (prev !== preference) {
      // Issue #29: same announcement path the Settings-tab dropdown uses
      // so the welcome-panel "Activate provider" buttons surface the
      // same context-forward notice.
      this.plugin._announceProviderChange(prev, preference);
    }
  }

  /**
   * Issue #29: one-shot status notice that fires when the user changes
   * Provider in Settings. Wording answers the user's implicit question
   * "what happens to my conversation when I switch?" — names the new
   * provider explicitly, the seed-history turn count (so the user knows
   * how much context flows forward), and the /new escape hatch.
   *
   * Skipped on first-time setup (no prior llm turns = nothing to
   * forward = no notice needed). Skipped also when the Provider
   * preference is the same value as before (idempotent saves).
   *
   * The seed count comes from the SAME function that produces the
   * provider's actual seed (`_extractLlmTurnsFromFullHistory`) so the
   * user-visible number can never drift from what's actually sent.
   */
  _flashProviderChangeNotice(prevPreference, newPreference) {
    if (!this._fullHistory || this._fullHistory.length === 0) return;
    const seed = this._extractLlmTurnsFromFullHistory();
    if (!seed || seed.length === 0) return; // nothing forward; skip
    const label = _providerLabelFor(newPreference);
    // Issue #30 deferred half: when the cap dropped older turns, surface
    // it in the notice so the user knows early context was lost — they
    // can /new to start truly fresh OR proceed knowing the new provider
    // only sees the recent tail. Without this signal, truncation
    // happens silently and "the model forgot what we discussed earlier"
    // looks like a model bug rather than a configurable seed cap.
    const stats = this._lastSeedStats || { dropped: 0 };
    const droppedSuffix = stats.dropped > 0
      ? ` (older ${stats.dropped} turn${stats.dropped === 1 ? "" : "s"} dropped — increase the model's context window or /new to start fresh)`
      : "";
    this._flashStatus(
      `Prior conversation (last ${seed.length} turns) will continue with ${label}${droppedSuffix}. Run /new to start fresh.`,
      6000,
    );
  }

  /**
   * Re-evaluate whether the welcome panel should be shown. Called from
   * the settings tab after any provider-affecting change so the panel
   * disappears as soon as the user configures a provider, no reload
   * required.
   *
   * @param {boolean} forceHide  — bypass the provider check and just hide
   */
  refreshWelcomePanel(forceHide = false) {
    if (!this._welcomePanelEl) return;
    if (forceHide) {
      this._welcomePanelEl.remove();
      this._welcomePanelEl = null;
      return;
    }
    const provider = createProvider(
      this.plugin,
      this.app.vault.adapter.basePath,
      {}
    );
    if (provider) {
      this._welcomePanelEl.remove();
      this._welcomePanelEl = null;
    }
  }

  // ── Message rendering ──

  addSystemMessage(text) {
    const msgEl = this.messagesEl.createDiv("gryphon-message gryphon-system");
    msgEl.createEl("span", { text, cls: "gryphon-system-text" });
    this.messages.push({
      role: "system", text, ts: new Date().toISOString(),
      source: "system",
      sessionId: this.plugin.settings.lastSessionId || null,
    });
    this._saveChatHistory();
    this.scrollToBottom();
  }

  /**
   * Render the canonical refusal reason from a protected-pattern deny,
   * independent of what the model later says. Exists because prompt
   * engineering can't fully suppress the model's preference for adding
   * preambles ("The Gryphon hook is blocking this") and epilogues
   * ("I can't bypass this") even with explicit anti-example phrases
   * and a bulleted source format. Guaranteeing the user sees the
   * authoritative text means emitting it ourselves, not relying on
   * the model.
   *
   * Rendered as a distinct alert-styled block (CSS: .gryphon-refusal)
   * so it reads as "Gryphon telling you what happened" vs. "the model's
   * take on what happened," which can differ in vocabulary.
   *
   * Dedup: a single protected tool-use typically triggers this twice
   * in Claude Code mode (once from the PreToolUse IPC, once from the tool
   * result returning with the same reason) and once in Anthropic API mode (from
   * permission-gate). Store a short-lived hash of the last refusal
   * text; if the next call matches within a few seconds, skip.
   */
  addRefusalMessage(text) {
    if (typeof text !== "string" || !text.trim()) return;
    const now = Date.now();
    if (this._lastRefusalText === text &&
        this._lastRefusalTs &&
        (now - this._lastRefusalTs) < 3000) {
      return;  // same refusal within 3 seconds — dedup
    }
    this._lastRefusalText = text;
    this._lastRefusalTs = now;
    // Per-turn flag used by finalizeStreamingMessage to decide whether
    // to collapse the assistant response into a <details>. More robust
    // than the 3s dedup window for long model turns that exceed the
    // window between refusal emit and assistant finalize.
    this._refusalInCurrentTurn = true;

    const msgEl = document.createElement("div");
    msgEl.className = "gryphon-message gryphon-refusal";
    const bubble = msgEl.createEl("div", { cls: "gryphon-bubble gryphon-bubble-refusal" });
    // Markdown render so the bullet list becomes actual bullets; the
    // text contains "- ..." items from our pre-bulleted prescriptive
    // format.
    MarkdownRenderer.render(this.app, text, bubble, "", this.plugin);

    // DOM ordering: if a streaming assistant bubble already exists (the
    // tool-use started BEFORE the refusal emit, which is the normal
    // order), the refusal block would otherwise append below it and
    // the user would see the assistant message above the authoritative
    // Gryphon block. Invert the expected order by inserting the refusal
    // *before* the streaming row. Standard append behavior kicks in
    // when no streaming bubble exists (refusal from a non-streaming
    // code path, e.g., SDK auto-deny).
    const assistantRow = this.streamingBubble && this.streamingBubble.parentElement;
    if (assistantRow && assistantRow.parentElement === this.messagesEl) {
      this.messagesEl.insertBefore(msgEl, assistantRow);
    } else {
      this.messagesEl.appendChild(msgEl);
    }

    this.messages.push({
      role: "system", text, ts: new Date().toISOString(),
      source: "system",
      sessionId: this.plugin.settings.lastSessionId || null,
    });
    this._saveChatHistory();
    this.scrollToBottom();
  }

  addUserMessage(text, source = "mechanical", opts = {}) {
    this._invalidatePromptHistoryCache();
    // Fresh user turn starts — clear any leftover refusal flag from
    // the previous turn so this turn's finalize doesn't accidentally
    // collapse.
    this._refusalInCurrentTurn = false;
    // Exit history-navigation mode. Without this, if the user pressed
    // Up to recall an old prompt, then hit Enter to send without
    // modifying the text, _promptHistoryIdx stays wherever it was
    // (Chromium doesn't fire the `input` event for programmatic
    // `inputEl.value = ""`). The next ArrowUp sees inHistoryMode=true
    // and runs the "decrement idx" branch — which silently returns
    // when idx is already 0, presenting as "Up-arrow does nothing."
    // Down-then-Up eventually clears the idx via the "past newest"
    // branch, which is how the user discovered the workaround.
    this._promptHistoryIdx = null;
    this._preHistoryInput = null;
    // Defensively strip the auto-injected [gryphon-context] prefix if a
    // caller accidentally hands us the already-composite form. The
    // store-what-the-user-typed invariant (so up-arrow recall works)
    // is maintained regardless of where the call originated.
    const cleanText = this._stripContextBlock(text);
    const msgRowCls = opts.sideNote
      ? "gryphon-message gryphon-user gryphon-sidenote"
      : "gryphon-message gryphon-user";
    const bubbleCls = opts.sideNote
      ? "gryphon-bubble gryphon-bubble-user gryphon-bubble-sidenote"
      : "gryphon-bubble gryphon-bubble-user";
    const msgEl = this.messagesEl.createDiv(msgRowCls);
    const bubble = msgEl.createDiv(bubbleCls);
    bubble.createEl("span", { text: "> ", cls: "gryphon-prompt-prefix" });
    bubble.createEl("span", { text: cleanText, cls: "gryphon-text" });
    if (opts.sideNote) {
      bubble.createEl("span", { text: " \u00B7 btw", cls: "gryphon-sidenote-tag" });
    }
    this.messages.push({
      role: "user", text: cleanText, ts: new Date().toISOString(),
      source,
      sideNote: opts.sideNote ? true : undefined,
      // Tagged with the session ID in effect at creation time so
      // `_doSaveChatHistory` can drop only messages that belong to
      // the current CLI session (those live in CC's jsonl). Messages
      // from a prior provider (SDK → CLI switch) or a compacted CLI
      // session carry a different tag and survive the filter.
      sessionId: this.plugin.settings.lastSessionId || null,
    });
    this._saveChatHistory();
    this.scrollToBottom();
  }

  startStreamingMessage() {
    const msgEl = this.messagesEl.createDiv("gryphon-message gryphon-assistant");
    const bubble = msgEl.createDiv("gryphon-bubble gryphon-bubble-assistant");
    const contentEl = bubble.createDiv("gryphon-text gryphon-streaming");
    this.streamingEl = contentEl;
    this.streamingBubble = bubble;
    this.streamingText = "";
    this.scrollToBottom();
    return contentEl;
  }

  replaceStreamingContent(fullText) {
    this.streamingText = fullText;
    if (this.streamingEl) {
      this.streamingEl.empty();
      MarkdownRenderer.render(this.app, fullText, this.streamingEl, "", this.plugin);
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(text, doneStatus, source = "mechanical", thinking = null) {
    this.clearStatus(doneStatus);

    // G3: when this assistant response is landing within a few seconds
    // of a canonical refusal emit (addRefusalMessage), collapse it into
    // a <details> block so the Gryphon-authored refusal stays visually
    // primary. The model's commentary is still there for users who
    // want it — just one click away — but it no longer competes for
    // attention with the authoritative text. Rationale:
    //   - When the model's reply is clean (good draw, no forbidden
    //     words): collapsed view removes redundant content without
    //     cost; user can expand if curious.
    //   - When the model's reply leaks "hook" / workaround
    //     suggestions (long-session bias): collapse hides the mess
    //     by default while keeping it inspectable.
    //   - Multi-tool turns aren't a concern because this only wraps
    //     the PRESENTATION. The model's tool sequence already
    //     completed; we're just deciding how to display the final
    //     text block.
    // Per-turn flag (set by addRefusalMessage, cleared here and on
    // the next user send). Time-window alternatives proved unreliable:
    // a slow-to-stream assistant response after an early refusal
    // could exceed any fixed window.
    const isPostRefusal = this._refusalInCurrentTurn === true;
    this._refusalInCurrentTurn = false;

    if (isPostRefusal && this.streamingBubble) {
      // Rebuild the bubble content as a collapsed disclosure. The
      // streaming element (`this.streamingEl`) was the inner text
      // area; we replace it with a <details> whose expanded body
      // holds the markdown-rendered response.
      this.streamingBubble.empty();
      this.streamingBubble.classList.add("gryphon-bubble-assistant-collapsed");
      const details = this.streamingBubble.createEl("details", {
        cls: "gryphon-assistant-details",
      });
      details.createEl("summary", {
        text: "Show assistant response",
        cls: "gryphon-assistant-summary",
      });
      const body = details.createEl("div", {
        cls: "gryphon-text gryphon-assistant-body",
      });
      MarkdownRenderer.render(this.app, text, body, "", this.plugin);
    } else if (this.streamingEl) {
      this.streamingEl.removeClass("gryphon-streaming");
      this.streamingEl.empty();
      // Issue #4: render thinking blocks (if any) as a collapsed
      // disclosure ABOVE the assistant text so the user knows extended
      // reasoning happened on this turn but it stays visually secondary.
      if (Array.isArray(thinking) && thinking.length > 0 && this.streamingBubble) {
        this._renderThinkingBlock(this.streamingBubble, thinking, this.streamingEl);
      }
      MarkdownRenderer.render(this.app, text, this.streamingEl, "", this.plugin);
    }
    const persisted = {
      role: "assistant", text, ts: new Date().toISOString(),
      source,
      sessionId: this.plugin.settings.lastSessionId || null,
    };
    if (Array.isArray(thinking) && thinking.length > 0) {
      persisted.thinking = thinking;
    }
    this.messages.push(persisted);
    this._saveChatHistory();
    this.streamingEl = null;
    this.streamingBubble = null;
    this.scrollToBottom();
    // If this finalize is the response to a /compact request, render
    // commit/cancel controls so the user can approve the summary.
    if (this._compactSummaryPending) {
      this._onCompactSummaryReady(text);
    }
  }

  /**
   * Flash a plugin-level message in the status bar. Transient — gets
   * overwritten by the next tool event or turn. Use this for feedback
   * that is NOT part of the LLM conversation (setting changes, /copy
   * confirmations, ambiguous-command warnings, etc.) so the chat area
   * stays reserved for user prompts and assistant responses.
   */
  _flashStatus(text) {
    if (this.toolbarStatus) this.toolbarStatus.textContent = text;
  }

  /**
   * Find a non-empty selection by cascading through three sources —
   * whichever still has the user's selection wins:
   *
   *   1. CodeMirror-tracked selections in any open markdown leaf
   *      (works for Source mode and Live Preview; CodeMirror retains
   *       selection state even when the editor loses DOM focus)
   *   2. Current window DOM selection
   *      (works if somehow still valid at call time)
   *   3. Cached selection from our document-wide selectionchange listener
   *      (works for Reading mode — rendered HTML selections — and for
   *       any workflow where the user clicked into the chat input
   *       between selecting and invoking /selection)
   *
   * @returns {{text: string, file: TFile|null}|null}
   */
  _findEditorSelection() {
    // 1. Check CodeMirror-tracked selections in any open markdown leaf.
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.editor) {
        try {
          const sel = view.editor.getSelection();
          if (sel) found = { text: sel, file: view.file || null };
        } catch {}
      }
    });
    if (found) return found;

    // 2. Check current window DOM selection.
    try {
      const winSel = document.getSelection();
      if (winSel && !winSel.isCollapsed) {
        const text = winSel.toString();
        if (text) {
          return { text, file: this.app.workspace.getActiveFile() };
        }
      }
    } catch {}

    // 3. Fall back to the cached selection from selectionchange listener.
    if (this._cachedSelection && this._cachedSelection.text) {
      return { text: this._cachedSelection.text, file: this._cachedSelection.file };
    }

    return null;
  }

  /**
   * Insert editor selection into the chat input as a blockquote. Called
   * by the /selection slash command (no args — discovers selection from
   * any open markdown leaf) or by the external Obsidian command
   * (passes explicit text + file — no discovery needed).
   */
  insertSelectionIntoInput(text, file) {
    if (!text) {
      const found = this._findEditorSelection();
      if (!found) {
        this._flashStatus("No text selected in any open markdown editor");
        return;
      }
      text = found.text;
      file = found.file;
    }
    const noteName = file ? file.basename : "editor";
    const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
    const block = `From [[${noteName}]]:\n${quoted}\n\n`;
    // Prepend so any in-flight typing is preserved after the quote.
    this.inputEl.value = block + (this.inputEl.value || "");
    this.inputEl.focus();
    // Cursor at end so the user continues typing after the quote.
    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
    // Grow textarea to fit.
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
    this._flashStatus(`Inserted selection from ${noteName}`);
  }

  /**
   * Build an ephemeral context block prepended to each send. Carries the
   * active file path so the LLM can ground "this note" references without
   * the user having to name it explicitly. Token-cheap (path only) —
   * Claude can Read the file on demand via its built-in tools.
   *
   * Not persisted to chat-history.json; the user's bubble stays clean.
   * Skipped when the active file is a prior Gryphon export — otherwise an
   * open export would self-reference on every new turn.
   */
  _buildContextPrefix() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return "";
    if (activeFile.path.startsWith("Gryphon/Exports/")) return "";
    // JSON-encode the path so unusual characters (brackets, quotes, the
    // literal close-tag string) can't prematurely terminate the context
    // block. Parsers/LLMs can unambiguously locate the closing [/...] tag.
    // The hint line nudges Claude to prefer this file as the starting
    // point: "the user's focus is here; check it first before going wide."
    // Costs ~25 extra tokens per turn; saves the common case of Claude
    // Glob'ing the whole vault when the answer lives in the open note.
    //
    // active_folder — Obsidian doesn't expose file-tree folder selection
    // to plugins, so we surface the PARENT of the active file as a proxy.
    // When the user says "this directory" or "these files", the parent
    // folder is usually what they mean.
    const parentDir = activeFile.parent && activeFile.parent.path
      ? activeFile.parent.path
      : "/";
    return (
      "[gryphon-context]\n" +
      `active_file: ${JSON.stringify(activeFile.path)}\n` +
      `active_folder: ${JSON.stringify(parentDir)}\n` +
      "hint: This file is the user's current focus. When answering, " +
      "read it first and prefer it as the primary source. References " +
      "like \"this directory\" / \"these files\" / \"this folder\" refer " +
      "to active_folder. Only search the wider vault if the answer is " +
      "not present in the focus file or its folder.\n" +
      "[/gryphon-context]\n\n"
    );
  }

  /**
   * Serialize the current conversation to a markdown note in the
   * Gryphon/Exports/ folder. Filename auto-derived from timestamp + first
   * user message, or overridden via /export <name>. The custom name is
   * slugified (path-traversal safe); collisions get a -N suffix so no
   * export silently overwrites another.
   */
  async _exportConversation(customName) {
    if (!this.messages || this.messages.length === 0) {
      this._flashStatus("Nothing to export \u2014 chat is empty");
      return;
    }
    const folder = "Gryphon/Exports";
    const baseSlug = customName
      ? this._slugify(customName) || this._deriveExportSlug()
      : this._deriveExportSlug();
    const content = this._formatExportMarkdown();
    try {
      await this._ensureFolder(folder);
      const filePath = this._uniqueExportPath(folder, baseSlug);
      await this.app.vault.create(filePath, content);
      this._flashStatus(`Exported \u2192 ${filePath}`);
    } catch (err) {
      this._flashStatus(`Export failed: ${err.message || err}`);
    }
  }

  /** Ensure a folder path exists, creating intermediate folders as needed. */
  async _ensureFolder(folderPath) {
    const parts = folderPath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  /** Append -1, -2, ... until a non-existing path is found, to avoid silent overwrites. */
  _uniqueExportPath(folder, baseSlug) {
    let candidate = `${folder}/${baseSlug}.md`;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${folder}/${baseSlug}-${n}.md`;
      n += 1;
    }
    return candidate;
  }

  /**
   * Slugify an arbitrary user-supplied string to a safe filename component.
   * Strips path traversal, control chars, and filesystem-hostile characters.
   * Returns an empty string if nothing usable remains.
   */
  _slugify(raw) {
    return (raw || "")
      .toString()
      .replace(/\.\./g, "")       // no parent-dir traversal
      .replace(/[\/\\]/g, "")     // no path separators
      .replace(/[^\w\s-]/g, "")   // alphanumerics, underscore, whitespace, hyphen
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 80);
  }

  _deriveExportSlug() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);                         // YYYY-MM-DD
    const time = now.toISOString().slice(11, 19).replace(/:/g, "");       // HHMMSS — seconds prevent same-minute collisions
    const firstUser = this.messages.find((m) => m.role === "user");
    const prefix = `${date}-${time}`;
    if (firstUser && firstUser.text) {
      const slug = this._slugify(firstUser.text.slice(0, 50));
      if (slug) return `${prefix}-${slug}`;
    }
    return `${prefix}-conversation`;
  }

  _formatExportMarkdown() {
    const lines = ["---"];
    lines.push(`source: gryphon-chat`);
    lines.push(`exported_at: ${new Date().toISOString()}`);
    lines.push(`model: ${this.plugin.settings.model || "unknown"}`);
    if (this.claudeProcess && this.claudeProcess.resolvedModel) {
      lines.push(`resolved_model: ${this.claudeProcess.resolvedModel}`);
    }
    lines.push(`messages: ${this.messages.length}`);
    lines.push(`cost_usd: ${this.cumulativeCost.toFixed(4)}`);
    lines.push("---");
    lines.push("");
    for (const msg of this.messages) {
      if (msg.role === "user") {
        lines.push("## User");
        lines.push("");
        // Issue #35 defense-in-depth: strip any composite that slipped
        // past the load/save gates so the export markdown matches what
        // the user TYPED, not the augmented form sent to the model.
        lines.push(this._stripContextBlock(msg.text));
        lines.push("");
      } else if (msg.role === "assistant") {
        lines.push("## Assistant");
        lines.push("");
        lines.push(msg.text);
        lines.push("");
      } else if (msg.role === "system") {
        lines.push(`> ${msg.text}`);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /**
   * Status text shown when no turn is in progress. Carries the "what do I
   * do now" hint that used to be a throwaway system message bubble.
   */
  _setIdleStatus() {
    if (!this.toolbarStatus) return;
    this.toolbarStatus.textContent = this.messages.length > 0
      ? "Session restored \u2014 type to continue"
      : "Type a message to start";
  }

  updateStatus(toolNameOrText) {
    // Map tool names to user-friendly status. SDK providers (OpenAI,
    // Gemini, Anthropic) emit snake_case tool names like
    // `run_shell_command` and `read_file`; CLI providers and the
    // classifier speak PascalCase Claude vocabulary (Bash, Read).
    // Normalize via the same alias table the classifier uses so a
    // single status mapping works for all providers — otherwise the
    // raw snake_case tool name leaks into the UI.
    let key = toolNameOrText;
    try {
      const { normalizeToolName } = require("@gryphon/protect");
      if (typeof toolNameOrText === "string" && toolNameOrText) {
        key = normalizeToolName(toolNameOrText);
      }
    } catch (_) { /* fall through with the raw name */ }

    let status = this.toolStatusMap[key];
    if (!status) {
      // Unknown identifier-shaped input (any tool-name-looking token,
      // PascalCase OR snake_case OR kebab-case) becomes "Thinking..."
      // — never the raw tool name. Only free-text status (e.g.
      // "Connecting to Codex...") passes through unchanged.
      if (toolNameOrText && /^[A-Za-z][A-Za-z0-9_\-]{1,40}$/.test(toolNameOrText)) {
        status = "Thinking...";
      } else {
        status = toolNameOrText || "Thinking...";
      }
    }
    if (this.toolbarStatus) {
      this.toolbarStatus.textContent = status;
    }
  }

  clearStatus(doneMessage) {
    // No argument means "clear the tool-activity text" — used mid-stream
    // when the first text chunk arrives and the chat bubble takes over as
    // the visible feedback. Idle state is set via _setIdleStatus().
    if (this.toolbarStatus) {
      this.toolbarStatus.textContent = doneMessage || "";
    }
  }

  addCostInfo(cost, duration) {
    const isDebug = (this.plugin.manifest.version || "").includes("debug");

    if (duration && this.toolbarStatus) {
      const current = this.toolbarStatus.textContent || "";
      const timeStr = `${(duration / 1000).toFixed(1)}s`;
      this.toolbarStatus.textContent = current ? `${current} (${timeStr})` : timeStr;
    }

    if (isDebug && cost !== undefined && cost !== null && cost > 0) {
      const costEl = this.messagesEl.createDiv("gryphon-cost");
      const parts = [`$${cost.toFixed(4)}`];
      if (duration) parts.push(`${(duration / 1000).toFixed(1)}s`);
      costEl.createEl("span", { text: parts.join(" \u00B7 "), cls: "gryphon-cost-text" });
    }
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  // ── Autocomplete ──
  //
  // Core provides slash-command autocomplete when the input starts with `/`.
  // Consuming plugins add autocomplete sources via `options.autocompleteSources`
  // (see constructor). First-match-wins across the source list; core's slash
  // source is always first, so plugins never have to re-handle "/" input.

  _updateAutocomplete() {
    const text = this.inputEl && this.inputEl.value;
    if (!text) { this._hideAutocomplete(); return; }
    for (const source of this.autocompleteSources) {
      if (source.matches(text)) {
        this._renderAutocompleteMatches(text, source.suggest(text));
        return;
      }
    }
    this._hideAutocomplete();
  }

  _renderAutocompleteMatches(text, matches) {
    if (!this.autocompleteEl) return;
    const query = text.toLowerCase();
    if (matches.length === 0 ||
        (matches.length === 1 && matches[0].cmd.toLowerCase() === query)) {
      this._hideAutocomplete();
      return;
    }
    // Snapshot the current status bar text the FIRST time the dropdown
    // appears in this typing session. Keyboard highlight / mouse hover
    // will replace the status with the hovered command's description;
    // _hideAutocomplete restores this snapshot when the dropdown closes.
    if (this.autocompleteEl.style.display === "none" &&
        this._statusBeforeAutocomplete === undefined) {
      this._statusBeforeAutocomplete = this.toolbarStatus
        ? this.toolbarStatus.textContent : "";
    }
    this.autocompleteEl.empty();
    for (const m of matches) {
      this._createAcItem(this.autocompleteEl, m.cmd, m.desc);
    }
    this.autocompleteEl.style.display = "block";
    this.autocompleteIdx = -1;
  }

  /**
   * Single source of truth for autocomplete item rendering. Any caller
   * adding items to the dropdown — core's /slash list, any consumer-
   * supplied source — goes through here. Guarantees:
   *   - dataset.cmd and dataset.desc are always set (so keyboard highlight
   *     and mouse hover both get the description for status preview)
   *   - mouseenter / mouseleave listeners wired (so hover-preview works)
   *   - click listener wired (so mouse click selects)
   *
   * Extracted so a new autocomplete source can't accidentally forget the
   * dataset contract, which caused past regressions where sources set
   * dataset.cmd but forgot dataset.desc or the hover listeners.
   */
  _createAcItem(parent, cmd, desc) {
    const item = parent.createDiv("gryphon-ac-item");
    item.dataset.cmd = cmd;
    item.dataset.desc = desc || "";
    item.createEl("span", { text: cmd, cls: "gryphon-ac-cmd" });
    item.addEventListener("click", () => this._selectAcItem(cmd));
    item.addEventListener("mouseenter", () => this._previewAcItem(item));
    item.addEventListener("mouseleave", () => this._restorePreAcStatus());
    return item;
  }

  _previewAcItem(el) {
    // Status line mirrors the dropdown selection: dropdown shows the
    // command, status shows what it does. Fall back to the command name
    // only if the source had no description attached.
    const desc = el.dataset.desc;
    const cmd = el.dataset.cmd;
    if (desc) this._flashStatus(desc);
    else if (cmd) this._flashStatus(cmd);
  }

  _restorePreAcStatus() {
    if (this._statusBeforeAutocomplete !== undefined) {
      this._flashStatus(this._statusBeforeAutocomplete);
    }
  }

  _hideAutocomplete() {
    if (this.autocompleteEl) {
      this.autocompleteEl.style.display = "none";
      this.autocompleteIdx = -1;
      // Fresh state for the next open — mouse vs keyboard detection
      // starts over rather than inheriting the prior mode.
      this.autocompleteEl.removeClass("gryphon-ac-kbnav");
    }
    // Restore the pre-autocomplete status text so a hover-preview or
    // highlight-preview doesn't leak past dropdown close.
    if (this._statusBeforeAutocomplete !== undefined) {
      this._flashStatus(this._statusBeforeAutocomplete);
      this._statusBeforeAutocomplete = undefined;
    }
  }

  _highlightAcItem(items) {
    items.forEach((el, i) => {
      if (i === this.autocompleteIdx) {
        el.addClass("gryphon-ac-active");
        el.scrollIntoView({ block: "nearest" });
        this._previewAcItem(el);
      } else {
        el.removeClass("gryphon-ac-active");
      }
    });
  }

  _selectAcItem(cmd) {
    // Append a trailing space when the command takes arguments so the user
    // can type the argument without a manual space keystroke.
    const entry = SLASH_COMMANDS.find((s) => s.cmd === cmd);
    const insertText = entry && entry.takesArgs ? cmd + " " : cmd;
    this.inputEl.value = insertText;
    this.inputEl.focus();
    this.inputEl.selectionStart = this.inputEl.selectionEnd = insertText.length;
    this._hideAutocomplete();
  }

  // ── Send ──

  async sendMessage() {
    this._userInitiatedAbort = false;
    // Cancel any pending rate-limit auto-retry — a fresh send (manual or
    // programmatic) supersedes the scheduled retry so we don't double-fire
    // the same prompt. Reset BOTH the timer handle AND the `_autoRetryFired`
    // gate so a future rate-limit later in this session can engage auto-
    // retry again. Round 3 R-1 fix: leaving the flag at `true` here meant
    // the auto-retry feature silently disabled itself for the rest of the
    // session after the first manual override of a scheduled retry. /clear
    // and onClose already reset both; sendMessage entry must do the same.
    if (this._autoRetryTimeout) {
      clearTimeout(this._autoRetryTimeout);
      this._autoRetryTimeout = null;
    }
    this._autoRetryFired = false;
    let text = this.inputEl.value.trim();
    if (!text) return;

    // Issue #34: capture the user's raw typed text BEFORE any expansion
    // (skills, /quote, /btw, etc.) so we can restore it to the input box
    // on rate-limit / quota errors. The downstream `text` variable gets
    // rewritten by those transforms, but the user typed the original —
    // re-typing after an error is the UX wart the issue calls out.
    const originalRawText = text;

    // Hide autocomplete and clear input up front so slash commands (which
    // can run during streaming, e.g. /stop) don't leak the typed text.
    this.autocompleteEl.style.display = "none";
    this.autocompleteIdx = -1;
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // Skill expansion — if text is /<name> [args] and <name> is a registered
    // skill, substitute the skill body for the input and continue as a
    // normal user message. This sits BEFORE handleChatCommand so skills
    // can't accidentally collide with built-ins (built-ins are in the
    // reserved-names set; the loader rejects colliding user skills).
    const expanded = this._maybeExpandSkill(text);
    if (expanded !== null) text = expanded;

    // /quote <args> — combine the editor selection with the user's
    // following question into one message. Without this branch, /quote
    // with trailing text falls through as a literal "/quote ..." to CC,
    // which has no such command and hedges in its response. Bare /quote
    // is handled by handleChatCommand below (inserts selection into the
    // input, no send).
    if (text.startsWith("/quote ")) {
      const args = text.slice(7).trim();
      const found = this._findEditorSelection();
      if (!found) {
        this._flashStatus("No text selected in any open markdown editor");
        this.inputEl.value = text; // restore so they can fix it
        return;
      }
      const noteName = found.file ? found.file.basename : "editor";
      const quoted = found.text.split("\n").map((l) => `> ${l}`).join("\n");
      text = `From [[${noteName}]]:\n${quoted}\n\n${args}`;
    }

    // /btw <text> — side-note context injection. Strip the "/btw "
    // prefix; the bubble shows the user's raw note. The LLM-facing
    // augmentation site wraps it with a "no expansion needed" preamble
    // so the model logs the note without burning tokens on a full
    // reply. Bare `/btw` falls through to the dispatch table for a
    // usage hint.
    let isSideNote = false;
    if (text.startsWith("/btw ")) {
      const note = text.slice(5).trim();
      if (note) {
        text = note;
        isSideNote = true;
      }
    }

    // Plugin-handled slash commands run BEFORE the isStreaming guard so
    // /stop and friends work while a turn is in flight. Slash commands
    // are plugin-level operations, not LLM sends.
    if (text.startsWith("/")) {
      if (await this.handleChatCommand(text)) { this.inputEl.focus(); return; }
    }

    // Non-slash input while streaming is queued and dispatched after the
    // current turn finalizes. Slash dispatch above runs first so /stop
    // and friends still take effect mid-turn.
    if (this.isStreaming) {
      this._enqueuePrompt(text);
      return;
    }

    // Extension hook: consuming plugins can intercept messages before
    // they're sent to the provider. If the hook returns truthy,
    // it consumed the message and we stop here. If the hook throws, we
    // treat it as consumed (safer default — don't forward ambiguous
    // user intent to the LLM) and surface the error in the status bar.
    if (this.onBeforeSend) {
      try {
        const consumed = this.onBeforeSend(text);
        if (consumed) return;
      } catch (e) {
        console.warn("[gryphon] onBeforeSend threw:", e);
        this._flashStatus(`Command handler error: ${e.message || e}`);
        return;
      }
    }

    // Forward to Claude
    this.addUserMessage(text, "llm", isSideNote ? { sideNote: true } : undefined);

    this.isStreaming = true;
    this.startStreamingMessage();

    const vaultPath = this.app.vault.adapter.basePath;
    const isNewProcess = !this.claudeProcess || !this.claudeProcess.isAlive();
    if (isNewProcess) {
      // v0.5.13: pass any pending compaction summary as a dedicated
      // `compactionSummary` option so the CLI provider can merge it
      // with the Gryphon system-prompt hint into a single
      // --append-system-prompt arg. Passing a raw --append-system-prompt
      // via extraArgs would clobber the provider's own (CC's commander
      // uses last-value-wins on single-value flags).
      const extraArgs = [...(this.extraProcessArgs || [])];
      const pendingSummary = this.plugin.settings.compactionSummary;
      let compactionPreamble = null;
      if (pendingSummary) {
        compactionPreamble =
          "## Conversation summary (compacted context)\n\n" +
          "The following is a summary of the conversation prior to compaction. Treat it as authoritative context for any reference to \"earlier\", \"previously\", or \"we decided\" in new messages.\n\n" +
          pendingSummary;
        this.plugin.settings.compactionSummary = null;
        this.plugin.saveSettings().catch(() => {});
      }
      // Seed SDK provider history from persisted LLM turns on first send
      // after reload. Claude Code mode doesn't need this — CC resumes via
      // --resume/lastSessionId — but SDK has no server-side session, so
      // chat-history.json IS the session. Only seeded once per provider
      // instance (cleared after use) so a /clear-and-restart doesn't
      // re-inject old turns.
      const sdkInitialHistory = this._consumeRestoredLlmHistory();
      // Auto-recover the IPC server if it's dropped into the transient
      // !isListening state since the last spawn — e.g. after a plugin
      // disable+enable cycle mid-session. For Claude Code mode this is the
      // difference between a full hook-based spawn (with NFKC-normalized
      // classify) and the deny-glob fallback (byte-exact, misses
      // Unicode obfuscation). Fast no-op when server is already healthy.
      // Anthropic API mode doesn't use IPC but the ensure() call is a cheap
      // check + bail, so we don't bother branching on provider type.
      //
      // If recovery fails AND the user is in Claude Code mode, tell them
      // BEFORE the spawn — the user just sent a prompt expecting
      // guardrails, and they deserve a signal that the guardrails
      // are degraded rather than finding out only via the CLI-path
      // Notice at spawn time (which competes with the streaming
      // response for their attention).
      const ipcReady = await this.plugin.ensureIpcListening(2000);
      if (!ipcReady && this.plugin.settings.providerPreference === "claude-code") {
        try {
          const { Notice } = require("obsidian");
          new Notice(
            `Gryphon: guardrail IPC is offline — this CLI send will run ` +
            `with basic pattern enforcement only (no Unicode normalization). ` +
            `Reload Obsidian (Cmd/Ctrl+P → "Reload app without saving") ` +
            `to restore full protection.`,
            10000,
          );
        } catch (_) { /* obsidian not available in tests */ }
      }
      this.claudeProcess = createProvider(this.plugin, vaultPath, {
        model: this.plugin.settings.model || undefined,
        effort: this.plugin.settings.effort || undefined,
        permissionMode: this.plugin.settings.permissionMode || undefined,
        resumeSessionId: this.plugin.settings.lastSessionId || undefined,
        compactionSummary: compactionPreamble,
        extraArgs,
        extraArgsByProvider: this.extraProcessArgsByProvider,
        initialHistory: sdkInitialHistory,
      });
      if (!this.claudeProcess) {
        // Bug #23: failed sends (no provider could be constructed) used
        // to lose both the user message AND the error bubble across
        // plugin disable+enable. Two issues conspired:
        //   1. addUserMessage() tagged the just-typed prompt with the
        //      current lastSessionId. If that ID looked like a CLI
        //      session, filterMessagesForSave() dropped the message
        //      on the assumption Claude Code's jsonl would re-supply
        //      it — but no CLI session ran, no jsonl was written,
        //      and the message vanished on reload.
        //   2. Save was fire-and-forget; a quick disable could
        //      interrupt the rename step before the new content
        //      committed to disk.
        // Fix: clear sessionId on the just-recorded user message so
        // the save filter can't drop it, then AWAIT the save before
        // returning so the user message + the error bubble (added by
        // _cleanupStreamingState → finalizeStreamingMessage) are
        // both flushed to disk before any subsequent disable.
        const lastUserMsg = this.messages[this.messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === "user") {
          lastUserMsg.sessionId = null;
        }
        this._cleanupStreamingState({ bubbleText: explainUnavailable(this.plugin) });
        // Awaited save: ensures both the user message and the error
        // bubble (just pushed by finalizeStreamingMessage inside
        // _cleanupStreamingState) hit disk before sendMessage returns
        // to the user, who is likely about to fix their config and
        // re-enable the plugin.
        await this._saveChatHistory();
        return;
      }
    }

    if (isNewProcess && this.streamingEl) {
      // Brand-aware label so codex-cli / gemini-cli sessions don't
      // say "Connecting to Claude". Same naming convention as the
      // approve/deny modal and the toolbar Model button.
      const { getActiveProviderKind } = require("@gryphon/provider-runtime");
      const kind = getActiveProviderKind(this.plugin) ||
                   this.plugin.settings.providerPreference;
      const assistant =
        (kind === "openai-api" || kind === "codex-cli")  ? "Codex"  :
        (kind === "google-api" || kind === "gemini-cli") ? "Gemini" :
        "Claude";
      this.updateStatus(`Connecting to ${assistant}...`);
    }

    let stderrLog = "";
    this.claudeProcess.onMessage = (text, type) => {
      // Any signal of life clears the stall indicator — text deltas, init,
      // tool invocations all count.
      if (this._stallTimeout) {
        clearTimeout(this._stallTimeout);
        this._stallTimeout = null;
      }
      if (type === "init") {
        if (this.streamingEl) this.updateStatus("Thinking...");
        this._refreshModelTooltip();
      } else if (type === "replace") {
        this.clearStatus();
        // Universal smush-fix: insert a paragraph break before
        // canonical Gryphon-emitted blocks if they land on the same
        // line as the model's prior text. SDK deltas + CLI stream
        // events accumulate text by `+=` per provider; when the
        // model emits "narration." then a tool call then "This
        // operation matches..." in the same iteration, the result
        // is "...narration.This operation matches..." with no
        // separator. Each provider could fix this in its own
        // accumulator (CC's content_block_start handler does), but
        // multiple providers share the same model behavior — a
        // single normalization here covers all six provider modes
        // in one place. User report 2026-05-04.
        this.replaceStreamingContent(
          _collapseSummaryDrafts(
            _separateCanonicalBlocks(
              _dedupeConsecutiveParagraphs(
                _replaceNoResponsePlaceholder(text),
              ),
            ),
          ),
        );
      } else if (type === "tool") {
        this.updateStatus(text);
      }
    };
    this.claudeProcess.onError = (text) => {
      console.warn(`[${this.viewDisplayText}] stderr:`, text);
      stderrLog += text + "\n";
    };
    // CLI provider fires this when it detects "No conversation found
    // with session ID" in CC's stderr and decides to respawn without
    // --resume. Wipe our persisted session ID so the NEXT provider
    // construction doesn't re-pass the same stale value, and surface a
    // one-line system message so the user understands why their chat
    // didn't resume.
    this.claudeProcess.onSessionExpired = () => {
      if (this.plugin.settings.lastSessionId) {
        this.plugin.settings.lastSessionId = null;
        this.plugin.saveSettings().catch(() => {});
      }
      this.addSystemMessage(
        "Your previous CLI session wasn't found (it may have been compacted or rotated). Starting a fresh session and re-sending your message.",
      );
    };

    // Stall timeout — if NO text/init/tool event in 10s, surface a soft
    // "still waiting" status. Doesn't abort (the 60s conn-timeout handles
    // that); just tells the user something is happening so a silently
    // retrying SDK call doesn't look like the chat is frozen. The SDK
    // retries 4xx-class rate-limit errors silently with backoff (Phase 6),
    // so a stall during heavy load is normal but invisible without this.
    this._stallTimeout = setTimeout(() => {
      if (this.isStreaming && this.streamingEl && !this.streamingText) {
        this.updateStatus("Still waiting (possibly rate-limited, retrying)...");
      }
    }, 10000);

    // Connection timeout — if no response within the model-adaptive
    // budget (issue #38), abort the stuck process and tear down
    // streaming state through the same shared helper that stopStreaming
    // uses. This is how R3-1 is prevented from regressing: there's only
    // one cleanup code path, no room for partial cleanup.
    //
    // Budget defaults to a per-model value (Haiku 30s, Sonnet 60s,
    // Opus 120s, Opus 1M 180s; non-Anthropic providers fall back to 60s)
    // so cold-start of large models has room to allocate KV-cache before
    // we declare the call hung. The user can override via Settings →
    // Gryphon → Connection timeout if their network is slow or their
    // prompts trigger unusually long warm-ups.
    const connBudgetMs = resolveConnectionTimeoutMs({
      override: this.plugin.settings.connectionTimeoutMs,
      model: this.plugin.settings.model,
    });
    this._connTimeout = setTimeout(() => {
      if (this.isStreaming && this.streamingEl && !this.streamingText) {
        const seconds = Math.round(connBudgetMs / 1000);
        const detail = stderrLog
          ? `**Debug:**\n\`\`\`\n${stderrLog.substring(0, 500)}\n\`\`\``
          : "Try again, switch to a faster model, or raise the timeout in Settings → Gryphon → Connection timeout.";
        this._cleanupStreamingState({
          bubbleText: `Connection timed out after ${seconds}s — no response from the model.\n\n${detail}`,
          doneStatus: "Timed out",
        });
      }
    }, connBudgetMs);

    try {
      // Auto-context: prepend active file path so "this note" references
      // resolve. Cheap (~50 tokens). User bubble still shows clean text
      // because addUserMessage(text, ...) already ran with the raw input.
      //
      // Conditionally prepend the anti-drift reminder block when the
      // user's text contains trigger keywords (delete, remove, sudo,
      // curl, etc. — derived from active protected-pattern lists plus
      // a hardcoded natural-language verb list). Adds ~60 tokens only
      // when the prompt is likely to face a protected-pattern refusal;
      // zero cost on all other turns. The block is stripped from the
      // displayed user bubble by _stripContextBlock — the model sees
      // the reminder, the user sees only their typed text.
      //
      // Neutralize any [gryphon-reminder] / [gryphon-context] markers
      // the user may have pasted (e.g., quoted from a note whose
      // content contains the literal tag). Without this, a pasted
      // file fragment could inject a forged reminder block that
      // overrides our directive — a prompt-injection amplifier
      // against the anti-drift UX. Safe neutralization: rename the
      // user's markers to a visibly-distinct variant so the model
      // still sees the text but doesn't parse it as a structural
      // block. Uses a unicode look-alike (fullwidth brackets) so the
      // change is perceptible if the user inspects context, and
      // collisions with our real brackets are impossible.
      const safeText = text
        .replace(/\[gryphon-reminder\]/gi, "[gryphon-reminder-user]")
        .replace(/\[\/gryphon-reminder\]/gi, "[/gryphon-reminder-user]")
        .replace(/\[gryphon-context\]/gi, "[gryphon-context-user]")
        .replace(/\[\/gryphon-context\]/gi, "[/gryphon-context-user]");
      const reminder = this._shouldInjectReminder(safeText) ? this._buildReminderBlock() : "";
      // Per-turn compound-request reminder. Independent of the
      // anti-drift reminder above (different problem class —
      // anti-drift fights paraphrasing of refusal copy; this fights
      // the model SKIPPING the refused sub-task entirely). Both can
      // fire on the same turn: a "summarize and delete X" prompt
      // hits both. RLHF safety bias on SDK-side models (GPT-5-mini,
      // Gemini 2.5) makes them silently drop the destructive half
      // even with a strong system prompt; placing the directive
      // adjacent to the user message lifts compliance.
      const compoundReminder = this._shouldInjectCompoundReminder(safeText)
        ? this._buildCompoundReminderBlock()
        : "";
      // Side-note wrap (issue #9, /btw): prepend the no-expansion
      // preamble so the model logs the note as context without burning
      // tokens on a full reply. The user bubble already shows the raw
      // note (rendered with .gryphon-bubble-sidenote styling).
      const sideNotePrefix = isSideNote
        ? "[Side note from user — no need to expand; reply in one sentence acknowledging it.]\n\n"
        : "";
      // Post-deny clarifier — fires only on the turn immediately
      // after a Gryphon protected-deny, then auto-clears. Counters
      // the "your message came through empty / system notification"
      // misinterpretation that long-running CC sometimes produces
      // on byte-identical retry prompts. Consume order matters:
      // place this AFTER the anti-drift + compound reminders but
      // BEFORE the user prompt so the model reads it as part of
      // "context for THIS turn." See _buildPostDenyClarifierBlock.
      const postDenyClarifier = this._consumePostDenyClarifier();
      // When the post-deny clarifier fires, SUPPRESS the other
      // reminder blocks for THIS turn. The model's "your message
      // came through empty / system notification" misinterpretation
      // is partly a function of the volume of leading metadata
      // blocks — four blocks stacked at the start reinforces the
      // "this is mostly system noise" inference. The clarifier is
      // the most-important directive in that scenario; collapsing
      // to only it (plus context) reduces the noise the model has
      // to wade through to find the user's actual prompt at the
      // bottom. User report 2026-05-04 (Linux Claude Code, second
      // attempt of "summarize and delete X" repeatedly produced
      // variations of the "empty message" rationalization despite
      // increasingly explicit clarifier wording).
      const effectiveReminder = postDenyClarifier ? "" : reminder;
      const effectiveCompound = postDenyClarifier ? "" : compoundReminder;
      const augmentedText = this._buildContextPrefix() + effectiveReminder + effectiveCompound + postDenyClarifier + sideNotePrefix + safeText;
      const result = await this.claudeProcess.send(augmentedText);
      if (this._connTimeout) { clearTimeout(this._connTimeout); this._connTimeout = null; }
      if (this._stallTimeout) { clearTimeout(this._stallTimeout); this._stallTimeout = null; }

      const rawResponseText = (result && result.text) ? result.text : (this.streamingText || "(No response)");
      // Apply the same normalizers we apply to live streaming text
      // (`replaceStreamingContent` path) so the FINALIZED bubble
      // matches what the user saw mid-stream — without this, the
      // dedupe + canonical-block separator only ran on streaming
      // updates and the final re-render of the bubble reverted to
      // the provider's raw turnText, surfacing duplicate paragraphs
      // we'd already collapsed live. User report 2026-05-04
      // (macOS Gemini CLI run 2 with three summary paragraphs).
      // `_replaceNoResponsePlaceholder` runs FIRST so the dedupe /
      // separator passes don't fight with the CC synthetic-message
      // string — we want to swap it for a meaningful explanation
      // before any other scrubber sees it.
      const responseText = _collapseSummaryDrafts(
        _separateCanonicalBlocks(
          _dedupeConsecutiveParagraphs(
            _replaceNoResponsePlaceholder(rawResponseText),
          ),
        ),
      );
      const thinking = (result && Array.isArray(result.thinking) && result.thinking.length > 0)
        ? result.thinking : null;
      // Core uses a generic "Done" status. Consuming plugins that want
      // response-sensitive status (e.g. "Page created") should wrap
      // this flow or override finalizeStreamingMessage — core stays
      // LLM-domain-agnostic per the file header contract.
      this.finalizeStreamingMessage(responseText, "Done", "llm", thinking);
      // Detect a protected-deny in the just-finalized turn so the
      // NEXT send can inject the post-deny clarifier reminder. This
      // is what counters Claude Code's "your message came through
      // empty" inference on byte-identical retry prompts after a
      // deny — see _buildPostDenyClarifierBlock for the full
      // rationale.
      this._markPriorTurnDenyIfPresent(responseText);

      if (result) {
        this.addCostInfo(result.cost, result.duration);
        this.cumulativeCost += result.cost || 0;
        if (result.sessionId) {
          this.plugin.settings.lastSessionId = result.sessionId;
          this.plugin.saveSettings();
          // Retag any null-sessionId LLM messages in this.messages
          // with the newly-established session ID. The situation:
          // on a fresh CLI session, addUserMessage fires before
          // any CC session exists and tags the user prompt with
          // sessionId=null. The CLI provider then establishes a
          // session and returns its UUID. Without this retag, the
          // save filter (which drops LLM messages whose sessionId
          // matches the current CLI session) sees sessionId=null
          // on the user msg, `null !== UUID` → keeps it in
          // chat-history.json. On next load, CC's jsonl ALSO has
          // the user msg (CC persisted it). Merge → duplicate user
          // bubble on reload. Retagging here closes the window
          // before the save filter runs on the next turn.
          //
          // Only retag messages that have null sessionId AND whose
          // ts is within the last 60 seconds — anything older is
          // legacy data from before this field existed, and MUST
          // NOT be re-tagged with a session that didn't own it.
          const now = Date.now();
          const cutoff = now - 60_000;
          for (const m of this.messages) {
            if (m.source !== "llm") continue;
            if (m.sessionId != null) continue;
            const ts = Date.parse(m.ts);
            if (!isFinite(ts) || ts < cutoff) continue;
            m.sessionId = result.sessionId;
          }
        }
        if (result.contextTokens) this.updateContextMeter(result.contextTokens);
      }
    } catch (err) {
      if (this._connTimeout) { clearTimeout(this._connTimeout); this._connTimeout = null; }
      if (this._stallTimeout) { clearTimeout(this._stallTimeout); this._stallTimeout = null; }

      // Lag-failsafe (issue #5 / v1.1.0): SDK reported the prompt
      // overflowed despite our last reading being below the 95%
      // threshold. Auto-compact and re-send the user's original text
      // transparently — no visible error since we recover.
      const errMsg = String((err && err.message) || err || "");
      const isOverflow = /prompt is too long|context_length_exceeded/i.test(errMsg);
      if (isOverflow && this._isSdkMode()) {
        // Tear down the empty streaming bubble; auto-compact will
        // re-render once the retry fires.
        if (this.streamingEl) {
          const assistantRow = this.streamingBubble && this.streamingBubble.parentElement;
          if (assistantRow && assistantRow.parentElement === this.messagesEl) {
            assistantRow.remove();
          }
          this.streamingEl = null;
          this.streamingBubble = null;
          this.streamingText = "";
        }

        // Special case: this overflow happened *inside* a compaction's
        // own summary turn (the conversation is so large that even the
        // summary prompt overflows). Emergency-trim the oldest history
        // entries on the provider, then retry the summary turn once. If
        // it still fails, fall through to the normal error surface.
        if (this._compactionPending && this._emergencyTrim(this.claudeProcess)) {
          this.isStreaming = false;
          this._userInitiatedAbort = false;
          this._flashStatus("Compaction summary too large — trimming oldest turns and retrying");
          // Re-fire the summary prompt through sendMessage. The
          // _compactSummaryPending flag is still set, so the finalize
          // path will route to _onCompactSummaryReady as expected.
          setTimeout(() => {
            this.inputEl.value = text;
            this.sendMessage();
          }, 0);
          return;
        }

        this.claudeProcess = null;
        this._userInitiatedAbort = false;
        // isStreaming must drop before _maybeStartAutoCompact dispatches
        // its summarization turn. Finally also sets it, but the gate
        // runs synchronously here so set it now.
        this.isStreaming = false;
        if (this._maybeStartAutoCompact({ lagFailsafe: true, retryText: text })) {
          return;
        }
        // Fall through if auto-compact declined (e.g., user disabled
        // the toggle) — surface the original error.
      }

      // Issue #36: tag the just-sent user prompt as failed BEFORE the
      // first save fires (finalizeStreamingMessage + addSystemMessage
      // each trigger one). See _markLastUserPromptFailed for the why.
      this._markLastUserPromptFailed();
      this.finalizeStreamingMessage(this.streamingText || "");
      this.addSystemMessage(`Error: ${err.message}`);
      // Issue #34: when the failure is a rate-limit / quota error, put
      // the user's original typed text back in the input box so they
      // don't have to re-type. Same UX consideration as form validation
      // errors. Detection covers Anthropic + OpenAI + Gemini wire shapes
      // (HTTP 429, RESOURCE_EXHAUSTED, "Too Many Requests", "Please
      // retry in", "rate-limited"). Only restores when the input is
      // currently empty so we don't clobber whatever the user has
      // already started typing for the next prompt.
      if (_isRateLimitError(err) && originalRawText && !this.inputEl.value) {
        this.inputEl.value = originalRawText;
        // Issue #34 deferred: when the user has opted in to auto-retry
        // AND we can parse a precise retry-after delay, schedule a
        // single auto-resubmit. No retry without a parsed delay
        // (avoids tight loops against unknown-cooldown rate limits)
        // and no chained retries (a second 429 is the user's call,
        // not ours — saves them from burning quota in a loop).
        const retryAfter = _parseRetryAfterSeconds(err);
        const autoRetry =
          this.plugin.settings.autoRetryOnRateLimit === true &&
          retryAfter !== null &&
          !this._autoRetryFired;
        if (autoRetry) {
          this._autoRetryFired = true;
          const ms = Math.ceil(retryAfter * 1000);
          this._flashStatus(
            `Rate limited — auto-retrying in ${Math.ceil(retryAfter)}s (turn off in Settings → Auto-retry on rate-limit).`,
            ms + 500,
          );
          this._autoRetryTimeout = setTimeout(() => {
            this._autoRetryTimeout = null;
            // Bail if the user has typed something else, /clear'd, or
            // closed the view in the meantime.
            if (!this.inputEl) return;
            if (this.inputEl.value !== originalRawText) return;
            this.sendMessage().finally(() => {
              this._autoRetryFired = false;
            });
          }, ms);
        } else {
          this._flashStatus(
            "Your prompt was preserved — press Send again when the rate limit clears.",
            6000,
          );
        }
      }
      // Tear down the dead provider instance but PRESERVE the server
      // session ID. A generic abort (connection timeout, network error,
      // SDK 4xx/5xx) doesn't mean the server-side session is gone — it
      // means this network call failed. The next provider spawn should
      // re-resume the same session via --resume <id> (CC) or seed
      // history from chat-history.json (SDK), preserving conversation
      // context. The dedicated `onSessionExpired` callback (fired only
      // when CC's stderr explicitly says the session is missing) is
      // the ONLY signal that should wipe lastSessionId.
      this.claudeProcess = null;
      this._userInitiatedAbort = false;
      // Issue #7: don't auto-drain queued prompts after a visible
      // error — the user just saw a failure and may want to switch
      // models, wait, or stop. _clearQueuedPrompts preserves the texts
      // in _pendingQueuedTexts (issue #6) so they remain reachable via
      // up-arrow recall, and restores the oldest into the input box.
      this._clearQueuedPrompts();
      this._sendErroredThisTurn = true;
    } finally {
      this.isStreaming = false;
      this.inputEl.focus();
      // Auto-compact takes priority over queued drain — if SDK context is
      // over the threshold, compact before draining so queued prompts
      // dispatch against the fresh post-compact session. The auto path
      // owns its own drain via _onCompactSummaryReady on commit. Skip
      // entirely if a compaction is already running so we don't drain
      // mid-flight. Also skip if the catch branch already cleared the
      // queue (issue #7).
      if (this._sendErroredThisTurn) {
        this._sendErroredThisTurn = false;
      } else if (this._autoCompactInProgress || this._compactionPending) {
        // owned by the in-flight compaction's own drain
      } else if (!this._maybeStartAutoCompact()) {
        this._drainQueuedPrompts();
      }
    }
  }
}

module.exports = {
  GryphonChatView,
  // Exported for unit testing only.
  filterMessagesForSave,
  computeContextPct,
  shouldStartAutoCompact,
  nextContextWarningState,
  modelButtonText,
  modelButtonTitle,
  _separateCanonicalBlocks,
  _dedupeConsecutiveParagraphs,
  _collapseSummaryDrafts,
  _isRateLimitError,
  _parseRetryAfterSeconds,
  _replaceNoResponsePlaceholder,
};
