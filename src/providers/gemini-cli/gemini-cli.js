/**
 * GeminiCliProvider — implements the LLMProvider contract via the
 * Google Gemini CLI (`@google/gemini-cli`). Each `send()` spawns a
 * fresh `gemini -p ... -o stream-json` process, parses its JSONL
 * event stream to EOF, and resolves with the final result.
 *
 * One-shot per turn (like CodexProvider, unlike claude-code's
 * persistent stdin loop). Resume threads the conversation via
 * `--resume <session_id>` from the previous turn.
 *
 * Auth: Gemini CLI requires either GEMINI_API_KEY in env or a
 * settings.json. We pass `settings.googleApiKey` (the same key the
 * google-api SDK provider already uses) into the spawn env as
 * GEMINI_API_KEY. If the key is empty the spawn will exit non-zero
 * with the CLI's own error message, surfaced to chat-view.
 *
 * Sandbox / approval: Gemini CLI has its own approval-mode system
 * (default | auto_edit | yolo | plan). Gryphon's permissionMode is
 * mapped to the closest CLI mode rather than wiring Gryphon-side
 * enforcement — see security trade-off documented in CodexProvider.
 *
 * Event stream (JSONL on stdout):
 *   { type: "init",        timestamp, session_id, model }
 *   { type: "message",     timestamp, role, content, delta? }
 *   { type: "tool_use",    timestamp, tool_name, tool_id, parameters }
 *   { type: "tool_result", timestamp, tool_id, status, output, error? }
 *   { type: "error",       timestamp, severity, message }
 *   { type: "result",      timestamp, status, stats: { input_tokens, output_tokens, total_tokens, cached, duration_ms, ... } }
 */

const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");
const {
  computeCost,
  coerceToVendorModel,
  DEFAULT_MODEL,
} = require("../google-api/pricing");
const dispatcher = require("../shared/hook-dispatcher");
const winSpawn = require("../shared/win-spawn");

/**
 * Map Gryphon's permissionMode to Gemini CLI's --approval-mode flag.
 *
 * Now that the HookDispatcher provides real pre-execution interception
 * via Gemini's BeforeTool hook (v1.3 Stage 5), the approval-mode
 * mapping is 1-for-1 with Gryphon's modes. Pattern enforcement
 * happens at the hook layer, not via approval-mode tightening.
 *
 *   default          → "default"   (Gemini prompts before risky tools)
 *   acceptEdits      → "auto_edit" (auto-approve edits, prompt for shell)
 *   plan             → "plan"      (read-only, no side effects)
 *   bypassPermissions→ "yolo"      (auto-approve everything)
 */
function _mapPermissionToApproval(permissionMode) {
  if (permissionMode === "plan") return "plan";
  if (permissionMode === "acceptEdits") return "auto_edit";
  if (permissionMode === "bypassPermissions") return "yolo";
  return "default";
}

// Synthetic prefix tagged onto session IDs we hand back to chat-view —
// see CodexProvider.SESSION_PREFIX for the rationale. Distinguishes a
// one-shot CLI session (chat-history.json is canonical) from a Claude-
// Code-style session (history re-supplied by the CLI on resume).
const SESSION_PREFIX = "gemini-cli-";

// Foreign provider prefixes — see codex-cli.js for the rationale.
// QA1-2, QA1-3.
const FOREIGN_PREFIX_RE = /^(sdk|openai-sdk|gemini-sdk|codex-cli)-/;

function _wrapSession(id) {
  if (!id) return null;
  if (typeof id !== "string") return null;
  if (FOREIGN_PREFIX_RE.test(id)) return null;
  if (id.startsWith(SESSION_PREFIX)) return id;
  return SESSION_PREFIX + id;
}

function _unwrapSession(id) {
  if (typeof id !== "string") return id;
  if (id.startsWith(SESSION_PREFIX)) return id.slice(SESSION_PREFIX.length);
  return id;
}

/**
 * Strip Gemini-side internal-mechanism leaks from the model's
 * user-facing text. Mirrors codex-cli's `_scrubInternalLeaks` —
 * removes any "BeforeTool" / "hook" prefix Gemini might append
 * when reporting a deny, plus the trailing "Command: <echoed
 * shell>" line if it appears. See codex-cli for full rationale.
 */
function _scrubInternalLeaks(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  // Leading "Command blocked by ... hook:" prefix in any form.
  out = out.replace(
    /^(?:[\s>]*)?Command blocked by [A-Za-z]*Tool[a-zA-Z]* hook:\s*/gim,
    "",
  );
  // Generic "blocked by ... hook" parenthetical the model might emit.
  out = out.replace(
    /\s*\((?:via|by|using|through)\s+[^)]*hook[^)]*\)/gi,
    "",
  );
  // Trailing "Command: <echoed shell>" segment, both inline and on
  // its own line.
  // V13H-3 (Round 2 re-fix): the prior anchored regex still ate fence
  // content when "Command:" appeared at start-of-line inside a code
  // fence. Guard each strip by checking that the candidate region
  // contains no triple-backtick fence — the appended trailer always
  // sits at end-of-message (no closing fence after), so a fence
  // anywhere in the candidate region is a code-block boundary.
  // See codex-cli.js _scrubInternalLeaks for the full rationale.
  const _stripTrailerIfSafe = (s) => {
    const m = s.match(/(?:^|\n)\s*Command:\s+[\s\S]+$/i);
    if (!m) return s;
    const tail = s.slice(m.index);
    if (tail.includes("```")) return s;
    return s.slice(0, m.index);
  };
  out = _stripTrailerIfSafe(out);
  const _stripInlineTrailerIfSafe = (s) => {
    const m = s.match(/\.[ \t]+Command:\s+[\s\S]+$/i);
    if (!m) return s;
    const tail = s.slice(m.index);
    if (tail.includes("```")) return s;
    return s.slice(0, m.index) + ".";
  };
  out = _stripInlineTrailerIfSafe(out);
  if (!out.includes("```")) {
    out = out.replace(/\n+\s*Command:\s+`?(?:rm|del|erase|unlink|shred)[^\n]*\n*/i, "\n\n");
  }
  return out.trim();
}

/**
 * Convert a Gemini API rate-limit / quota-exhausted error body into a
 * friendly user-facing message. Returns null when the input doesn't
 * look like a rate-limit error (caller falls back to other handling).
 *
 * Inputs the function copes with:
 *   - Plain stderr text containing "Please retry in 27.4s." (the
 *     human-readable form some Gemini CLI versions print).
 *   - Doubly-nested JSON dumps (`{"error":{"message":"{...
 *     \"code\":429... Please retry in 52s\"}"}}`) — these arrive
 *     via the JSONL `error` event on Linux when the API returns 429.
 *   - Mixed bodies that contain `RESOURCE_EXHAUSTED` /
 *     `quotaMetric: ...PerDay` markers without an explicit
 *     "Please retry in" phrase (some Gemini-CLI versions on
 *     daily-cap exhaustion).
 *
 * The output explains the per-day vs per-minute distinction and
 * surfaces the quota dimension Google actually hit so users can
 * tell whether waiting will help today or not.
 */
function _formatRateLimitMessage(body) {
  if (typeof body !== "string" || body.length === 0) return null;

  // Quick reject: not a rate-limit body if no rate-limit markers.
  if (!/[Pp]lease retry in|RESOURCE_EXHAUSTED|generate_content_free_tier|429/.test(body)) {
    return null;
  }

  // Extract retry-after seconds. Pattern matches both "Please retry
  // in 12.3s" and "Please retry in 500ms". Returns null if neither
  // is present (rare — mostly daily-cap-exhausted bodies sometimes
  // omit a meaningful retry).
  const retryMatch = body.match(/[Pp]lease retry in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/);
  let seconds = null;
  if (retryMatch) {
    const value = parseFloat(retryMatch[1]);
    const unit = retryMatch[2];
    seconds = unit === "ms" ? value / 1000 : value;
  }

  // Sub-second blip — transient, just retry immediately.
  if (seconds !== null && seconds < 1) {
    return (
      `Gemini returned a transient blip (retry suggested in ${Math.round(seconds * 1000)}ms). ` +
      `Try again — this usually clears immediately.`
    );
  }

  // Mine the body for the quota dimension Google actually hit. The
  // 429 response carries quotaMetric / quotaId / quotaDimensions
  // fields that tell us whether the per-day or per-minute cap fired.
  // Keep a few short lines so the user (and we) can diagnose without
  // dumping the entire JSON.
  const interestingLines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /quotaMetric|quotaId|quotaValue|quota_metric|RESOURCE_EXHAUSTED|generativelanguage|model=|quotaDimensions|GenerateRequestsPerDay|GenerateRequestsPerMinute|free_tier_requests/i.test(l),
    )
    .slice(-6)
    .join("\n");
  const detail = interestingLines
    ? `\n\nGoogle's response:\n${interestingLines}`
    : "";

  // The body might explicitly name the per-day quota — surface that
  // distinction prominently because per-day exhaustion isn't
  // recoverable by waiting Xs (Google's retry-after value is
  // decorative in that case; the cap only resets at 00:00 Pacific).
  const isPerDay = /PerDay|per_day_per_project|free_tier_requests/i.test(body);

  const headline = seconds !== null
    ? `Gemini rate-limited this request. Google said retry in ~${Math.ceil(seconds)}s.`
    : `Gemini rate-limited this request (no retry-after value provided).`;

  const explainer = isPerDay
    ? `\n\nThis appears to be the per-day cap on Gemini's free tier — ` +
      `waiting Xs won't help today. Free-tier daily quotas only reset at ` +
      `00:00 Pacific. Switch models (e.g. gemini-2.5-flash-lite has a ` +
      `separate quota bucket), wait until tomorrow, or upgrade your plan ` +
      `at aistudio.google.com.`
    : `\n\nIf retries keep failing past that window, you've likely hit ` +
      `the per-day cap (not the per-minute one). Free-tier daily quotas ` +
      `only reset at 00:00 Pacific. Check usage at aistudio.google.com.`;

  return headline + explainer + detail;
}

class GeminiCliProvider {
  constructor(geminiPath, cwd, options = {}) {
    this.geminiPath = geminiPath;
    this.cwd = cwd;
    this.options = options;
    this.process = null;
    this.alive = false;
    this.sessionId = _wrapSession(options.resumeSessionId) || null;
    this.resolvedModel = coerceToVendorModel(options.model);
    this.contextTokens = 0;
    this.lastCumulativeCost = 0;

    this._buffer = "";
    this._stderrTail = "";
    this._turnText = "";
    this._lastStats = null;
    this._currentResolve = null;
    this._currentReject = null;

    this.onMessage = null;
    this.onError = null;
    this.onDone = null;
    this.onSessionExpired = null;
  }

  _buildArgs(prompt, { hooksWired = false } = {}) {
    // When Gryphon's BeforeTool hook is installed, force Gemini to
    // yolo so the full tool palette is exposed in headless mode.
    // The hook is the authoritative gate — every tool call reaches
    // Gryphon's classify handler before execution. Without this,
    // headless `-p` mode hides tools that would otherwise prompt
    // for approval, and the model reports "I have no shell tool".
    //
    // Without hooks, fall back to the user's mapped mode 1-for-1 —
    // we don't want to silently elevate to YOLO when there's no
    // gate. Plan mode is preserved either way (it's read-only and
    // doesn't need shell exposed).
    const userMode = _mapPermissionToApproval(this.options.permissionMode);
    const approvalMode = (hooksWired && userMode !== "plan") ? "yolo" : userMode;
    const args = [
      "-p", prompt,
      "-o", "stream-json",
      "--skip-trust",
      "--approval-mode", approvalMode,
    ];

    if (this.options.model) {
      args.push("-m", this.options.model);
    }

    // Resume the prior session if we captured one; else start fresh.
    // The CLI expects a raw session_id — strip our synthetic prefix.
    if (this.sessionId) {
      args.push("--resume", _unwrapSession(this.sessionId));
    }

    if (this.options.extraArgs && Array.isArray(this.options.extraArgs)) {
      args.push(...this.options.extraArgs);
    }

    return args;
  }

  _buildEnv() {
    const env = { ...process.env, PATH: buildEnhancedPath() };
    // Source the API key from settings preferentially, then fall back
    // to GOOGLE_API_KEY in process.env (same chain the factory uses to
    // gate availability — keeping them symmetric so a user with only
    // the env var doesn't pass `getActiveProviderKind === "gemini-cli"`
    // and then fail at spawn with "GEMINI_API_KEY not set"). Code review
    // V13-1.
    const settings = (this.options.plugin && this.options.plugin.settings) || {};
    const settingsKey = settings.googleApiKey || "";
    const envKey = process.env.GOOGLE_API_KEY || "";
    const key = settingsKey || envKey;
    if (key) env.GEMINI_API_KEY = key;
    return env;
  }

  send(prompt) {
    return new Promise((resolve, reject) => {
      // Supersede an in-flight turn — same shape as CodexProvider.
      if (this.alive && this.process) {
        try { this.process.kill("SIGTERM"); } catch {}
        if (this._currentReject) {
          const r = this._currentReject;
          this._currentReject = null;
          this._currentResolve = null;
          r(new Error("Superseded by new message"));
        }
      }

      this._currentResolve = resolve;
      this._currentReject = reject;
      this._buffer = "";
      this._stderrTail = "";
      this._turnText = "";
      this._lastStats = null;
      this._failed = false; // QA1-1
      // Track the prompt so _handleStaleSession can replay it on the
      // recovery path (`gemini --resume <uuid>` reports "Invalid
      // session identifier" when the JSONL has been wiped from
      // ~/.gemini/tmp/.../chats/).
      this._lastPrompt = prompt;
      // Reset one-shot stale-recovery flag at the start of each
      // user-initiated send. Mirrors codex-cli's pattern.
      this._staleRecoveryFired = false;

      // Drop --resume on the next spawn if the prior turn ended with
      // a Gryphon protected-deny. The resumed session would carry the
      // canonical deny copy in its transcript, letting the model echo
      // it on the next turn without ever invoking the tool again
      // (no hook fires → no modal → looks like an "auto-deny" to the
      // user). One-shot: consumeTaintedSession clears the entry so
      // subsequent non-deny turns resume normally.
      const plugin = this.options.plugin;
      const rawSessionId = this.sessionId ? _unwrapSession(this.sessionId) : null;
      if (plugin && typeof plugin.consumeTaintedSession === "function" &&
          rawSessionId && plugin.consumeTaintedSession(rawSessionId)) {
        this.sessionId = null;
      }

      // HookDispatcher: install Gryphon's BeforeTool / AfterTool /
      // SessionStart hooks for this spawn. On success, we get env
      // overlay (GEMINI_CLI_SYSTEM_SETTINGS_PATH +
      // GRYPHON_PERMISSION_SOCKET + GRYPHON_HOOK_DIALECT). On
      // degraded result we proceed with no hooks and a warning —
      // matches the codex-cli + claude-code soft-fail policy.
      const hookExtras = dispatcher.prepareSpawn({
        kind: "gemini-cli",
        plugin: this.options.plugin,
        options: this.options,
      });
      if (!hookExtras.ok && hookExtras.degradationReason) {
        console.warn(`[gryphon/gemini-cli] hooks degraded: ${hookExtras.degradationReason}`);
      }
      this._hookCleanup = hookExtras.cleanup;

      // _buildArgs needs to know whether hooks are wired so it can
      // choose the right --approval-mode. With hooks installed,
      // Gryphon's BeforeTool gate is the authoritative permission
      // check; Gemini's approval-mode just controls which tools land
      // in the model's palette. In headless `-p` mode with
      // approval-mode=default, tools that need approval simply don't
      // appear (model thinks "I have no shell tool") — see user
      // report 2026-05-03. Forcing yolo here exposes the full
      // palette; the hook still gates each call.
      const args = this._buildArgs(prompt, { hooksWired: !!hookExtras.ok });

      if (hookExtras.args && hookExtras.args.length > 0) {
        args.push(...hookExtras.args);
      }

      const spawnOpts = {
        cwd: this.cwd,
        env: { ...this._buildEnv(), ...(hookExtras.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
      };

      // Windows .cmd shim handling — same fix as codex-cli.js. The
      // prior `shell:true` path silently truncated multi-line prompts
      // (gryphon-context block) at the first newline because cmd.exe
      // treats unquoted newlines as command terminators. wrapForCmdShim
      // builds the cmd.exe /c command line ourselves with proper
      // CommandLineToArgvW quoting + windowsVerbatimArguments.
      let spawnCommand = this.geminiPath;
      let spawnArgs = args;
      if (winSpawn.isWindowsShim(this.geminiPath)) {
        const wrapped = winSpawn.wrapForCmdShim(this.geminiPath, args);
        spawnCommand = wrapped.command;
        spawnArgs = wrapped.args;
        Object.assign(spawnOpts, wrapped.options);
      }

      let proc;
      try {
        proc = spawn(spawnCommand, spawnArgs, spawnOpts);
      } catch (err) {
        if (this._hookCleanup) { this._hookCleanup(); this._hookCleanup = null; }
        reject(err);
        return;
      }
      this.process = proc;
      this.alive = true;

      const forThis = () => this.process === proc;
      proc.stdout.on("data", (data) => { if (forThis()) this._handleStdout(data); });
      proc.stderr.on("data", (data) => { if (forThis()) this._handleStderr(data); });
      proc.on("close", (code) => { if (forThis()) this._handleClose(code); });
      proc.on("error", (err) => { if (forThis()) this._handleProcessError(err); });
    });
  }

  _handleStdout(data) {
    this._buffer += data.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        this._processEvent(parsed);
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          console.error("GeminiCliProvider: error processing event:", e);
        }
      }
    }
  }

  _processEvent(raw) {
    if (!raw || typeof raw !== "object") return;

    if (raw.type === "init") {
      if (typeof raw.session_id === "string" && raw.session_id) {
        this.sessionId = _wrapSession(raw.session_id);
      }
      if (typeof raw.model === "string" && raw.model) {
        this.resolvedModel = raw.model;
      }
      if (this.onMessage) this.onMessage("", "init");
      return;
    }

    if (raw.type === "message") {
      // Echoed user-message events are emitted at turn start. Skip them
      // — chat-view manages user-side rendering itself.
      if (raw.role === "user") return;
      if (raw.role !== "assistant") return;

      // The CLI emits assistant text either as a single non-delta event
      // or as a sequence of delta events; either way, accumulate.
      if (typeof raw.content === "string" && raw.content) {
        if (raw.delta) {
          this._turnText += raw.content;
        } else {
          this._turnText = raw.content;
        }
        // Scrub the same internal-mechanism leaks Codex's adapter
        // strips (BeforeTool / hook / "Command: ..." trailing echo)
        // so the chat UI matches Claude Code's clean style across
        // all three providers.
        const cleaned = _scrubInternalLeaks(this._turnText);
        if (this.onMessage) this.onMessage(cleaned, "replace");
      }
      return;
    }

    if (raw.type === "tool_use") {
      // Pattern enforcement now happens at the BeforeTool hook layer
      // via the HookDispatcher (v1.3 Stage 5). This branch only
      // emits the friendly tool callback for chat-view rendering.
      const toolName = raw.tool_name || "tool";
      if (this.onMessage) this.onMessage(toolName, "tool");
      return;
    }

    if (raw.type === "tool_result") {
      // Chat-view doesn't render tool results separately; the model's
      // next message text reflects whatever the tool returned.
      return;
    }

    if (raw.type === "error") {
      const rawMsg = raw.message ? String(raw.message) : "Gemini CLI turn failed";
      // Normalize rate-limit / quota-exhausted bodies that arrive in
      // the JSONL `error` event. On Linux, the 429 from Google
      // arrives here (not as plain stderr in _handleClose) and the
      // raw `message` is a doubly-nested JSON dump that's
      // unreadable to a user. _formatRateLimitMessage extracts the
      // useful retry-after / quota dimension and produces the same
      // friendly text shown for stderr-path 429s. Falls back to
      // the raw message when the input doesn't look like a Google
      // quota error. User report 2026-05-04 (Linux Gemini CLI).
      const friendlyMsg = _formatRateLimitMessage(rawMsg) || rawMsg;
      if (this.onError) this.onError(friendlyMsg);
      // Only reject the pending promise on FATAL errors. The CLI emits
      // `error` events at severity="warning" too (e.g. resource-exhausted
      // retries that the CLI handles internally) — those would
      // erroneously kill the turn if we always rejected. Use severity
      // !== "warning" as the gate; default to fatal when severity isn't
      // present. Code review V13-2.
      if (raw.severity !== "warning") {
        const reject = this._currentReject;
        this._currentResolve = null;
        this._currentReject = null;
        this._failed = true;
        if (reject) reject(new Error(friendlyMsg));
      }
      return;
    }

    if (raw.type === "result") {
      this._lastStats = raw.stats || null;
      if (this._lastStats) {
        this.contextTokens = this._lastStats.input_tokens || 0;
      }
      return;
    }
  }

  _handleStderr(data) {
    const text = data.toString();
    if (!text) return;
    this._stderrTail = (this._stderrTail + text).slice(-4096);

    const trimmed = text.trim();
    if (!trimmed) return;

    // Auth-missing case → surface a clean error.
    if (/Please set an Auth method|GEMINI_API_KEY/i.test(trimmed)) {
      if (this.onError) this.onError(
        "Gemini CLI authentication is not set. Paste a Google API key in " +
        "Settings → Gryphon → Google API key, then retry."
      );
      return;
    }
  }

  _handleClose(code) {
    this.alive = false;
    this.process = null;
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch (e) {
        console.warn(`[gryphon/gemini-cli] hook cleanup failed: ${e.message}`);
      }
      this._hookCleanup = null;
    }

    // V13-2: if a fatal `error` JSONL event already rejected the
    // pending promise, don't emit a second close-time error.
    if (this._failed) {
      this._failed = false;
      return;
    }

    const resolve = this._currentResolve;
    const reject = this._currentReject;
    this._currentResolve = null;
    this._currentReject = null;
    if (!resolve) return;

    if (code === 0 && this._lastStats) {
      // Map Gemini stream-json stats → google-api/pricing computeCost
      // shape (which expects GenerateContentResponse.usageMetadata).
      const mappedUsage = {
        promptTokenCount: this._lastStats.input_tokens || 0,
        candidatesTokenCount: this._lastStats.output_tokens || 0,
        cachedContentTokenCount: this._lastStats.cached || 0,
      };
      const { cost } = computeCost(mappedUsage, this.resolvedModel);
      this.lastCumulativeCost += cost;

      const result = {
        text: this._turnText || "",
        cost,
        cumulativeCost: this.lastCumulativeCost,
        sessionId: this.sessionId,
        duration: this._lastStats.duration_ms || 0,
        contextTokens: this.contextTokens,
      };
      if (this.onDone) this.onDone(result);
      resolve(result);
      return;
    }

    // Failure path.
    const stderr = (this._stderrTail || "").trim();

    // Stale-session recovery: Gemini emits "Error resuming session:
    // Invalid session identifier <uuid>" when --resume is passed an
    // id whose JSONL no longer exists at ~/.gemini/tmp/.../chats/
    // (vault renamed, tmp cache cleared, prior turn never completed
    // its rollout, etc.). Recover transparently by dropping the
    // stored session id and re-sending the prompt as a fresh
    // session — same pattern codex-cli + claude-code use. One-shot
    // per provider instance via `_staleRecoveryFired` so a second
    // failure doesn't loop.
    // User report 2026-05-04 (macOS).
    //
    // Skip recovery when the failed turn ALREADY produced output
    // (`_turnText` non-empty). In that scenario Gemini emitted the
    // resume error to stderr but still ran on stdout — the user got
    // a complete response. Re-sending would produce the same answer
    // a second time and the chat-view would render BOTH summaries
    // back-to-back ("...summary 1...summary 2...deny"). Better:
    // resolve normally with the text we have. Future turns still
    // benefit because we drop the stored sessionId so the next
    // user message starts fresh.
    if (/Error resuming session:|Invalid session identifier/i.test(stderr) &&
        !this._staleRecoveryFired) {
      this._staleRecoveryFired = true;
      if (this._turnText && this._turnText.length > 0) {
        // Output already streamed — quietly clear the bad sessionId
        // so the NEXT user turn doesn't repeat the resume failure,
        // then resolve with the text we have. Don't fire
        // onSessionExpired here (no need for a "session not found"
        // notice when the user already got their answer).
        this.sessionId = null;
        this.options.resumeSessionId = undefined;
        const result = {
          text: this._turnText || "",
          cost: 0,
          cumulativeCost: this.lastCumulativeCost,
          sessionId: null,
          duration: 0,
          contextTokens: this.contextTokens,
        };
        if (this.onDone) this.onDone(result);
        resolve(result);
        return;
      }
      // No output yet — clear any partial streaming-bubble text the
      // chat view may have shown (e.g. an empty "init" placeholder),
      // then re-send. Without the explicit clear, a subsequent
      // _turnText reset still leaves whatever the chat-view last
      // rendered visible until the fresh turn streams its first
      // delta — which on a slow first byte produces a moment of
      // stale text. Cheap belt-and-suspenders.
      if (this.onMessage) {
        try { this.onMessage("", "replace"); } catch (_) { /* best effort */ }
      }
      // Re-attach the resolve/reject so the recovery path can fire
      // them when the fresh spawn completes.
      this._currentResolve = resolve;
      this._currentReject = reject;
      this._handleStaleSession();
      return;
    }

    // Detect Gemini rate-limit errors and surface a clean, friendly
    // message instead of dumping the raw stack with `[Object]`
    // placeholders. The CLI emits a Node Error object's `inspect`
    // representation when the service returns 429, which looks like:
    //   "Please retry in 27.4s.', details: [ [Object], [Object] ] },
    //    retryDelayMs: undefined, reason: undefined }"
    // — confusing to users. Parse the retry-after seconds and
    // surface them clearly. User report 2026-05-03.
    //
    // Important: don't misattribute the rate limit to "your key" or
    // push the user toward an API key. In CLI mode the user is
    // typically on Gemini CLI's free OAuth tier (Gemini 2.5 Flash
    // has generous free quota on this path), and that is exactly
    // what's being throttled here. Suggesting "switch to API mode"
    // wouldn't necessarily help — free API keys hit the same kinds
    // of per-account caps. The honest framing is: free tier exists,
    // it has caps, waiting is usually the answer. We don't suggest
    // a key fix because in most cases the user just needs to wait.
    //
    // Parse both `Xs` and `Xms` units — Gemini uses whichever is
    // appropriate. Sub-second retries are transient blips (network
    // jitter, brief server contention), not user-actionable rate
    // limits. Surface them as such — the user can just retry
    // immediately rather than waiting some opaque "55ms".
    const friendly = _formatRateLimitMessage(stderr);
    if (friendly) {
      reject(new Error(friendly));
      return;
    }

    const tail = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join("\n");
    const header = code === 0
      ? "Gemini CLI ended without producing a response."
      : `Gemini CLI exited unexpectedly (exit code ${code}).`;
    const details = tail ? `\n\nDetails from Gemini CLI:\n${tail}` : "";
    const hint =
      "\n\nCommon causes: missing API key, the prompt was rejected by the " +
      "approval mode, or a transient API error. Verify the CLI works by " +
      "running `gemini -p 'hello' -o stream-json --skip-trust` in a " +
      "terminal with GEMINI_API_KEY set.";
    reject(new Error(header + details + hint));
  }

  /**
   * Stale-session recovery — mirrors CodexProvider._handleStaleSession.
   * Runs when stderr matched `"Error resuming session"` /
   * `"Invalid session identifier"`. Drops the stored session id,
   * notifies the host (chat-view) to clear its persisted
   * lastSessionId, then re-spawns WITHOUT --resume on the same
   * pending Promise so the user sees a brief delay then their
   * answer streams in normally.
   *
   * One-shot per provider instance — `_staleRecoveryFired` is set
   * before this runs. If the fresh spawn ALSO fails, the second
   * error surfaces normally.
   */
  _handleStaleSession() {
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch {}
      this.process = null;
    }
    this.alive = false;
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch {}
      this._hookCleanup = null;
    }

    // Drop the stale session id so the next _buildArgs omits --resume.
    this.sessionId = null;
    this.options.resumeSessionId = undefined;

    // Tell the host (chat-view) to clear its persisted lastSessionId
    // so a fresh provider construction doesn't read it back.
    if (typeof this.onSessionExpired === "function") {
      try { this.onSessionExpired(); } catch {}
    }

    const prompt = this._lastPrompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      const reject = this._currentReject;
      this._currentResolve = null;
      this._currentReject = null;
      if (reject) reject(new Error(
        "Gemini resumed a session that no longer exists. Try the request " +
        "again — Gryphon has cleared the stale session id."
      ));
      return;
    }

    // Hook the new spawn into the same outer Promise. We can't call
    // this.send(prompt) directly because that would return a NEW
    // Promise; the original caller is still awaiting our ORIGINAL
    // send()'s Promise.
    const origResolve = this._currentResolve;
    const origReject = this._currentReject;
    this._buffer = "";
    this._stderrTail = "";
    this._turnText = "";
    this._lastStats = null;
    this._failed = false;

    // V13H-2: hoist the orig-promise reattachment OUT of the
    // microtask body — close the synchronous-reentry fragility
    // before scheduling _respawnFresh. See the matching fix in
    // codex-cli.js for the full rationale.
    this._currentResolve = origResolve;
    this._currentReject = origReject;

    Promise.resolve().then(() => {
      try {
        this._respawnFresh(prompt);
      } catch (e) {
        if (origReject) origReject(e);
      }
    });
  }

  /**
   * Re-spawn after a stale-session detection. Mirrors the spawn
   * logic in send() but skips supersede / argument-rebuild details
   * we don't need on the recovery path. The fresh process attaches
   * to the same _currentResolve / _currentReject so completion
   * resolves the original Promise.
   */
  _respawnFresh(prompt) {
    const hookExtras = dispatcher.prepareSpawn({
      kind: "gemini-cli",
      plugin: this.options.plugin,
      options: this.options,
    });
    if (!hookExtras.ok && hookExtras.degradationReason) {
      console.warn(`[gryphon/gemini-cli] hooks degraded on stale-session retry: ${hookExtras.degradationReason}`);
    }
    this._hookCleanup = hookExtras.cleanup;

    const args = this._buildArgs(prompt, { hooksWired: !!hookExtras.ok });
    if (hookExtras.args && hookExtras.args.length > 0) {
      args.push(...hookExtras.args);
    }

    const spawnOpts = {
      cwd: this.cwd,
      env: { ...this._buildEnv(), ...(hookExtras.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    };
    let spawnCommand = this.geminiPath;
    let spawnArgs = args;
    if (winSpawn.isWindowsShim(this.geminiPath)) {
      const wrapped = winSpawn.wrapForCmdShim(this.geminiPath, args);
      spawnCommand = wrapped.command;
      spawnArgs = wrapped.args;
      Object.assign(spawnOpts, wrapped.options);
    }

    let proc;
    try {
      proc = spawn(spawnCommand, spawnArgs, spawnOpts);
    } catch (err) {
      if (this._hookCleanup) { this._hookCleanup(); this._hookCleanup = null; }
      const reject = this._currentReject;
      this._currentResolve = null;
      this._currentReject = null;
      if (reject) reject(err);
      return;
    }
    this.process = proc;
    this.alive = true;
    const forThis = () => this.process === proc;
    proc.stdout.on("data", (data) => { if (forThis()) this._handleStdout(data); });
    proc.stderr.on("data", (data) => { if (forThis()) this._handleStderr(data); });
    proc.on("close", (code) => { if (forThis()) this._handleClose(code); });
    proc.on("error", (err) => { if (forThis()) this._handleProcessError(err); });
  }

  _handleProcessError(err) {
    this.alive = false;
    this.process = null;
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch (_) { /* swallow — best effort */ }
      this._hookCleanup = null;
    }
    const reject = this._currentReject;
    this._currentResolve = null;
    this._currentReject = null;
    if (reject) reject(err);
  }

  abort() {
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch {}
      const proc = this.process;
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      this.process = null;
    }
    this.alive = false;
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch (_) { /* swallow — best effort */ }
      this._hookCleanup = null;
    }
    const reject = this._currentReject;
    this._currentResolve = null;
    this._currentReject = null;
    if (reject) reject(new Error("Aborted"));
  }

  isAlive() {
    return this.alive && this.process !== null;
  }

  // Cost is estimated from token counts × Google pricing tables — same
  // status as openai-api / anthropic-api / google-api SDK adapters.
  get costIsEstimate() { return true; }
}

module.exports = {
  GeminiCliProvider,
  _mapPermissionToApproval,
  _wrapSession,
  _unwrapSession,
  _scrubInternalLeaks,
  SESSION_PREFIX,
  DEFAULT_MODEL,
};
