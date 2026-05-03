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
 *   - extraProcessArgs     — CLI args appended to every CLI provider spawn
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
const { createProvider, explainUnavailable, detectAvailable } = require("./providers/factory");
const {
  TOOL_STATUS_CORE, MODELS, EFFORTS, PERMS, MODEL_CONTEXT, SLASH_COMMANDS,
  CC_BLOCKED_IN_STREAM_JSON,
  CONTEXT_WARN_PCT, CONTEXT_WARN_RESET_PCT, AUTO_COMPACT_SDK_THRESHOLD_PCT,
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
// SDK provider session prefixes. The CLI optimization in
// filterMessagesForSave drops llm messages tagged with the current CLI
// session (because Claude Code's jsonl re-supplies them on resume) — but
// SDK sessions have no such re-supply, so dropping them is data loss.
// We detect SDK sessions by their synthetic prefix:
//   - "sdk-..."          → anthropic-api (legacy; emit pre-Stage-2)
//   - "openai-sdk-..."   → openai-api    (Stage 2)
//   - "gemini-sdk-..."   → google-api    (Stage 3)
// Anything else (typically a UUID) is treated as a CLI session.
const _SDK_SESSION_PREFIX_RE = /^(sdk|openai-sdk|gemini-sdk)-/;

function filterMessagesForSave(messages, currentSessionId) {
  const currentId = currentSessionId || null;
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
  const { getActiveProviderKind } = require("./providers/factory");
  const kind = getActiveProviderKind(plugin) || settings.providerPreference;

  if (kind === "openai-api") {
    const {
      getModelDropdownOptions,
      resolveModel: resolveOpenAIModel,
      DEFAULT_MODEL: OPENAI_DEFAULT_MODEL,
    } = require("./providers/openai-api/pricing");
    const options = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
    const requested = settings && settings.model;
    // Defensive fallback when the persisted model id isn't an OpenAI option
    // (e.g. cross-vendor switch with `model="sonnet"`): mirror what
    // pricing.resolveModel will pick at runtime so the toolbar label
    // matches the actual API request — no UI/runtime gap (Round 18 F23-1).
    if (options.some((o) => o.value === requested)) {
      return labelFor(options, requested);
    }
    const resolved = resolveOpenAIModel(requested);
    const fitsDropdown = options.some((o) => o.value === resolved);
    return labelFor(options, fitsDropdown ? resolved : OPENAI_DEFAULT_MODEL);
  }
  if (kind === "google-api") {
    const {
      getModelDropdownOptions: getGeminiOptions,
      resolveModel: resolveGeminiModel,
      DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
    } = require("./providers/google-api/pricing");
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
  const { getActiveProviderKind } = require("./providers/factory");
  const kind = getActiveProviderKind(plugin) || settings.providerPreference;
  if (kind === "openai-api") return "Model (OpenAI)";
  if (kind === "google-api") return "Model (Gemini)";
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
    inputArea.createEl("span", { text: "\u276F", cls: "gryphon-input-prompt" });

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
    const { getActiveProviderKind } = require("./providers/factory");
    const kind = getActiveProviderKind(this.plugin) ||
                 this.plugin.settings.providerPreference;

    let modelList = MODELS;
    if (kind === "openai-api") {
      const { getModelDropdownOptions } = require("./providers/openai-api/pricing");
      modelList = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
    } else if (kind === "google-api") {
      const { getModelDropdownOptions } = require("./providers/google-api/pricing");
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
   * Re-compute toolbar button labels in place. Called by the plugin's
   * _resetActiveSessions() whenever a setting changes that affects what
   * the toolbar should display \u2014 most notably providerPreference, since
   * switching to openai-api / google-api in Settings should immediately
   * change the model button from "Sonnet" to the Stage-N-pending label
   * (Bug #21).
   */
  refreshToolbarLabels() {
    if (this.modelBtn) {
      this.modelBtn.setText(modelButtonText(this.plugin) + " \u25be");
      this.modelBtn.setAttribute("title", modelButtonTitle(this.plugin));
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
    if (bubbleText !== undefined && this.streamingEl) {
      this.finalizeStreamingMessage(bubbleText, doneStatus);
    } else if (fallbackFlash) {
      this._flashStatus(fallbackFlash);
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
    bubble.createEl("span", { text: "❯ ", cls: "gryphon-prompt-prefix" });
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
  _extractLlmTurnsFromFullHistory() {
    const MAX_SDK_SEED_TURNS = 100;
    if (!this._fullHistory || this._fullHistory.length === 0) return [];
    const llmOnly = this._fullHistory.filter(
      (m) => m.source === "llm" && (m.role === "user" || m.role === "assistant")
    );
    const tail = llmOnly.slice(-MAX_SDK_SEED_TURNS);
    // Ensure we start with a user turn — Anthropic's API rejects
    // histories that begin with an assistant message.
    const firstUserIdx = tail.findIndex((m) => m.role === "user");
    if (firstUserIdx < 0) return [];
    return tail.slice(firstUserIdx).map((m) => ({
      role: m.role,
      content: m.text,
    }));
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
    // Match the block shapes used by _buildContextPrefix() (vault-path
    // context) and _buildReminderBlock() (anti-drift reminder for
    // protected-pattern-likely prompts), tolerating trailing whitespace
    // between the closing tag and the user's actual text. Both block
    // types are stripped so the user's displayed bubble shows only
    // their typed text, while the model still sees the full augmented
    // payload.
    return text
      .replace(/^\s*\[gryphon-context\][\s\S]*?\[\/gryphon-context\]\s*/, "")
      .replace(/^\s*\[gryphon-reminder\][\s\S]*?\[\/gryphon-reminder\]\s*/, "");
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
    const { resolveActivePatterns } = require("./providers/anthropic-api/tools/path-utils");

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
      await fs.promises.writeFile(tmpPath, JSON.stringify(filtered));
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
            for (const m of parsed) {
              if (!m.ts) m.ts = "2000-01-01T00:00:00Z"; // backward compat
              merged.push(m);
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
                merged.push({ role: "user", text: d.content, ts, source: "llm", sessionId });
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
    return merged;
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
      bubble.createEl("span", { text: "\u276F ", cls: "gryphon-prompt-prefix" });
      bubble.createEl("span", { text: msg.text, cls: "gryphon-text" });
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
      msgEl.className = "gryphon-message gryphon-system";
      msgEl.createEl("span", { text: msg.text, cls: "gryphon-system-text" });
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
      const { displayPath } = require("./utils");
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
    this.plugin.settings.providerPreference = preference;
    await this.plugin.saveSettings();
    this.plugin._resetActiveSessions();
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
    bubble.createEl("span", { text: "\u276F ", cls: "gryphon-prompt-prefix" });
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
        lines.push(msg.text);
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
    // Map tool names to user-friendly status. Unknown PascalCase identifiers
    // (likely tool names) become "Thinking..."; anything else passes through.
    let status = this.toolStatusMap[toolNameOrText];
    if (!status) {
      if (toolNameOrText && /^[A-Z][a-zA-Z_]{1,20}$/.test(toolNameOrText)) {
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
    let text = this.inputEl.value.trim();
    if (!text) return;

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
      this.updateStatus("Connecting to Claude...");
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
        this.replaceStreamingContent(text);
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

    // Connection timeout — if no response in 60s, abort the stuck process
    // and tear down streaming state through the same shared helper that
    // stopStreaming uses. This is how R3-1 is prevented from regressing:
    // there's only one cleanup code path, no room for partial cleanup.
    this._connTimeout = setTimeout(() => {
      if (this.isStreaming && this.streamingEl && !this.streamingText) {
        const detail = stderrLog
          ? `**Debug:**\n\`\`\`\n${stderrLog.substring(0, 500)}\n\`\`\``
          : "Try again or switch to a faster model.";
        this._cleanupStreamingState({
          bubbleText: `Connection timed out. The model may be slow to start.\n\n${detail}`,
          doneStatus: "Timed out",
        });
      }
    }, 60000);

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
      // Side-note wrap (issue #9, /btw): prepend the no-expansion
      // preamble so the model logs the note as context without burning
      // tokens on a full reply. The user bubble already shows the raw
      // note (rendered with .gryphon-bubble-sidenote styling).
      const sideNotePrefix = isSideNote
        ? "[Side note from user — no need to expand; reply in one sentence acknowledging it.]\n\n"
        : "";
      const augmentedText = this._buildContextPrefix() + reminder + sideNotePrefix + safeText;
      const result = await this.claudeProcess.send(augmentedText);
      if (this._connTimeout) { clearTimeout(this._connTimeout); this._connTimeout = null; }
      if (this._stallTimeout) { clearTimeout(this._stallTimeout); this._stallTimeout = null; }

      const responseText = (result && result.text) ? result.text : (this.streamingText || "(No response)");
      const thinking = (result && Array.isArray(result.thinking) && result.thinking.length > 0)
        ? result.thinking : null;
      // Core uses a generic "Done" status. Consuming plugins that want
      // response-sensitive status (e.g. "Page created") should wrap
      // this flow or override finalizeStreamingMessage — core stays
      // LLM-domain-agnostic per the file header contract.
      this.finalizeStreamingMessage(responseText, "Done", "llm", thinking);

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

      this.finalizeStreamingMessage(this.streamingText || "");
      this.addSystemMessage(`Error: ${err.message}`);
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
};
