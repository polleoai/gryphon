/**
 * CodexProvider — implements the LLMProvider contract via the OpenAI
 * `codex` CLI (Codex.app). Each `send()` spawns a fresh `codex exec`
 * (or `codex exec resume <id>`) process, parses its JSONL event stream
 * to EOF, and resolves with the final result.
 *
 * One-shot per turn: unlike claude-code (persistent stdin loop), Codex
 * exec exits after each turn. Resume threads the conversation via
 * `--resume <thread_id>` from the previous turn.
 *
 * Auth: handled by the CLI itself (`codex login`). The provider never
 * touches credentials. If the user isn't logged in, the CLI exits
 * non-zero with an explanatory stderr message which we surface verbatim.
 *
 * Sandbox: Codex's own sandbox handles tool execution (file read/write,
 * shell). We map Gryphon's permissionMode → Codex's sandbox mode rather
 * than wiring Gryphon-side enforcement. This is a documented trade-off:
 * the 27-event hook surface that gives `claude-code` Gryphon's two-axis
 * security has no equivalent here. Users who need Gryphon-enforced
 * protected-pattern rules should choose claude-code or one of the SDK
 * adapters instead.
 *
 * Event stream (JSONL on stdout):
 *   { type: "thread.started", thread_id: "<uuid>" }
 *   { type: "turn.started" }
 *   { type: "item.started",   item: { id, type, ... } }       — tool invocations
 *   { type: "item.completed", item: { id, type, text? } }     — agent_message holds final text
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
 */

const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");
const {
  computeCost,
  coerceToVendorModel,
  coerceToCodexCliModel,
  CODEX_CLI_DEFAULT_MODEL,
  DEFAULT_MODEL,
} = require("@gryphon/provider-config").pricing.openai;
const { hookDispatcher: dispatcher } = require("@gryphon/protect");
const { winSpawn } = require("@gryphon/protect");

/**
 * Detect whether the host kernel supports Codex's sandbox modes that
 * require landlock (workspace-write, read-only). Codex's Linux sandbox
 * uses landlock + seccomp; on kernels without landlock (Linux <5.13)
 * sandbox initialization fails and every shell call returns "local
 * command runner failed." On non-Linux platforms Codex uses different
 * sandbox tech (sandbox-exec on macOS, AppContainer on Windows) that
 * isn't gated on landlock.
 *
 * Returns false ONLY on Linux <5.13. macOS, Windows, and Linux ≥5.13
 * return true. Cached after first call (kernel version doesn't change
 * mid-process).
 *
 * Implementation note: parses os.release() rather than checking
 * /proc/sys/kernel/landlock_abi_version because the latter requires
 * a privileged read on some distros and we can't add that dependency.
 * Version parsing is good enough — landlock has been stable in 5.13+.
 */
const os = require("os");
let _landlockSupportCache = null;
function _supportsLandlockSandbox() {
  if (_landlockSupportCache !== null) return _landlockSupportCache;
  if (process.platform !== "linux") {
    _landlockSupportCache = true;
    return true;
  }
  try {
    const release = os.release();  // e.g. "5.10.0-18-arm64" or "6.1.0-amd64"
    const m = release.match(/^(\d+)\.(\d+)/);
    if (!m) {
      _landlockSupportCache = false;
      return false;
    }
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    _landlockSupportCache = major > 5 || (major === 5 && minor >= 13);
  } catch (_) {
    _landlockSupportCache = false;
  }
  return _landlockSupportCache;
}

/**
 * Map Gryphon's permissionMode to Codex's --sandbox flag.
 *
 * Now that the HookDispatcher provides real pre-execution interception
 * via Codex's PreToolUse hooks (v1.3 Stage 5), the sandbox mapping is
 * 1-for-1 with Gryphon's modes. Pattern enforcement happens at the
 * hook layer, not at the sandbox layer.
 *
 *   default          → workspace-write (typical agentic editing)
 *   acceptEdits      → workspace-write
 *   plan             → read-only
 *   bypassPermissions→ danger-full-access (explicit YOLO opt-in)
 *
 * Linux landlock fallback (2026-05-04): on Linux kernels <5.13,
 * workspace-write and read-only both fail to initialize ("local
 * command runner failed"). We detect that case and fall through to
 * danger-full-access so the provider is usable. Gryphon's PreToolUse
 * hook still gates every tool call — the sandbox layer was redundant
 * for security per the comment above. The trade-off is the loss of
 * Codex's belt-and-suspenders workspace confinement; acceptable when
 * the alternative is "Codex CLI doesn't work on this host." A
 * one-time console warning surfaces the downgrade for diagnostics.
 */
function _mapPermissionToSandbox(permissionMode) {
  let target;
  if (permissionMode === "plan") target = "read-only";
  else if (permissionMode === "bypassPermissions") target = "danger-full-access";
  else target = "workspace-write";

  // Landlock fallback: when the kernel can't run the requested
  // sandbox, downgrade to danger-full-access (which doesn't need
  // landlock). bypassPermissions is already danger-full-access — no
  // change. Plan / default / acceptEdits modes get downgraded with
  // a one-time warning.
  if (target !== "danger-full-access" && !_supportsLandlockSandbox()) {
    if (!_landlockWarningEmitted) {
      _landlockWarningEmitted = true;
      console.warn(
        "[gryphon/codex-cli] Linux kernel " + os.release() + " is pre-landlock " +
        "(landlock requires Linux ≥5.13). Codex's '" + target + "' sandbox can't " +
        "initialize on this kernel. Falling back to '--sandbox danger-full-access' " +
        "so the provider is usable. Gryphon's PreToolUse hook still gates every " +
        "tool call. Upgrade to Linux ≥5.13 to restore the workspace-write sandbox " +
        "as defense-in-depth.",
      );
    }
    return "danger-full-access";
  }
  return target;
}
let _landlockWarningEmitted = false;

// Synthetic prefix tagged onto session IDs we hand back to chat-view.
// Distinguishes Codex-CLI sessions from Claude-Code-style sessions for
// filterMessagesForSave (which uses prefix matching to decide whether
// to drop on save). Strip before passing to the CLI on --resume.
const SESSION_PREFIX = "codex-cli-";

// Known prefixes from OTHER providers. If chat-view's persisted
// `lastSessionId` carries one of these (user just switched providers
// without clearing the id, or two open chat views raced), treating it
// as a Codex thread to resume would fail every send. Detect + treat as
// "no resume" instead. QA1-2, QA1-3.
const FOREIGN_PREFIX_RE = /^(sdk|openai-sdk|gemini-sdk|gemini-cli)-/;

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
 * Strip Codex-side internal-mechanism leaks from the model's
 * user-facing text so the chat UI matches Claude Code's clean style.
 *
 * When Gryphon's PreToolUse hook denies a command, Codex returns a
 * tool result like "Command blocked by PreToolUse hook: <reason>" to
 * the model. The model then paraphrases or quotes that verbatim into
 * its assistant message. Users shouldn't see "PreToolUse hook" in
 * the chat — it leaks the implementation detail and contradicts
 * Gryphon's positioning of the protection as "your protected
 * pattern list" (which is what Claude Code's tuned system prompt
 * already enforces).
 *
 * Stripping at the provider boundary is a robust complement to
 * model-prompt instructions: even if the model occasionally lapses
 * and includes the prefix, the user never sees it. The cleaned text
 * still carries the meaningful content (the reason field, the
 * Settings instructions) — only the implementation-detail prefix is
 * removed.
 *
 * Patterns covered: literal prefix at start of text, the same prefix
 * inside a code fence, and the trailing "Command: ..." echo Codex
 * sometimes appends.
 */
function _scrubInternalLeaks(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  // Strip leading "Command blocked by PreToolUse hook: " prefix in any
  // form (start of string, start of paragraph). The deny reason that
  // follows is the user-facing content we want to preserve.
  out = out.replace(
    /^(?:[\s>]*)?Command blocked by PreToolUse hook:\s*/gim,
    "",
  );
  // Strip a model-paraphrase pattern observed in the wild: "blocked
  // via a pre-tool hook" / "blocked (by the hook)" etc. We strip the
  // entire parenthetical mechanism reference (any phrase that
  // contains "hook" inside parens preceded by via/by/using/through),
  // leaving the surrounding sentence intact. Greedy `[^)]*` keeps
  // the regex simple and won't over-match because parens nest rarely
  // in model output.
  out = out.replace(
    /\s*\((?:via|by|using|through)\s+[^)]*hook[^)]*\)/gi,
    "",
  );
  // Strip a trailing "Command: <echoed shell>" segment some Codex
  // versions append after the deny reason — noise, the user already
  // sees the deny message and doesn't need the echoed shell command.
  // Match the segment whether it's on its own line OR inlined on the
  // same line as the preceding sentence (the model frequently
  // concatenates "Ask me again. Command: rm ..." on a single line).
  //
  // V13H-3 (Round 2 re-fix): the prior regex `/(?:^|\n)\s*Command:\s+[\s\S]+$/`
  // still ate fence content when "Command:" appeared at start-of-line
  // INSIDE a code fence — `[\s\S]+$` is greedy and walks across the
  // closing ``` fence and any trailing prose. Real-world hit: an
  // assistant response that quotes a shell example like
  //   ```
  //   ls -la
  //   Command: ls
  //   ```
  //   That's how it works.
  // would be stripped from `\nCommand: ls` through end-of-string,
  // including the closing fence and the explanation paragraph.
  //
  // Fix: only strip the trailer when there is NO triple-backtick fence
  // marker between the candidate "Command:" position and end-of-string.
  // Codex's appended trailer is always at the very end of the message
  // (no closing fence after it); a fence after a "Command:" position
  // is therefore guaranteed to be a code-block boundary, not a real
  // trailer.
  const _stripTrailerIfSafe = (s) => {
    const m = s.match(/(?:^|\n)\s*Command:\s+[\s\S]+$/i);
    if (!m) return s;
    const tail = s.slice(m.index);
    if (tail.includes("```")) return s; // candidate is inside / before a code fence
    return s.slice(0, m.index);
  };
  out = _stripTrailerIfSafe(out);
  // Also strip the inlined "<sentence>. Command: <shell>" form where
  // the trailer follows sentence punctuation on the same line —
  // common when the model concatenates "Ask me again. Command: rm".
  // Match only when the trailer extends through end-of-string AND no
  // code fence intervenes (same V13H-3 reasoning as above).
  const _stripInlineTrailerIfSafe = (s) => {
    const m = s.match(/\.[ \t]+Command:\s+[\s\S]+$/i);
    if (!m) return s;
    const tail = s.slice(m.index);
    if (tail.includes("```")) return s;
    return s.slice(0, m.index) + ".";
  };
  out = _stripInlineTrailerIfSafe(out);
  // Also strip if it appears inside the message rather than at end
  // (rare but observed). Limit to one occurrence to avoid eating
  // legitimate occurrences of "Command:" in code-block content.
  // Skip entirely if a code fence is present anywhere in the text —
  // the targeted "rm/del/erase/unlink/shred" verbs may legitimately
  // appear in fenced code samples.
  if (!out.includes("```")) {
    out = out.replace(/\n+\s*Command:\s+`?(?:rm|del|erase|unlink|shred)[^\n]*\n*/i, "\n\n");
  }
  return out.trim();
}


class CodexProvider {
  constructor(codexPath, cwd, options = {}) {
    this.codexPath = codexPath;
    this.cwd = cwd;
    this.options = options;
    this.process = null;
    this.alive = false;
    // Wrap the resumed id so chat-view sees the prefixed form regardless
    // of whether it was supplied prefixed or raw. The CLI gets the raw
    // form via _unwrapSession in _buildArgs.
    this.sessionId = _wrapSession(options.resumeSessionId) || null;
    // Codex CLI's ChatGPT-account auth rejects API-only ids
    // (gpt-5-mini, gpt-4o, o3, etc.) at request time. Coerce to the
    // empirically-supported subset (`gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`)
    // so a stale persisted id from API mode falls back to a working
    // default rather than 400-ing on every spawn. See pricing/openai.js
    // CODEX_CLI_SUPPORTED_MODELS for the rationale.
    this.resolvedModel = coerceToCodexCliModel(options.model);
    this.contextTokens = 0;
    this.lastCumulativeCost = 0;

    this._buffer = "";
    this._stderrTail = "";
    this._turnText = "";
    this._lastUsage = null;
    this._currentResolve = null;
    this._currentReject = null;

    this.onMessage = null;
    this.onError = null;
    this.onDone = null;
    this.onSessionExpired = null;
  }

  /**
   * Build the argv for one `codex exec` (or `codex exec resume`) spawn.
   * Each turn rebuilds args from scratch — the process is one-shot, so
   * we don't carry argv state between turns.
   *
   * IMPORTANT: `codex exec resume` accepts a NARROWER flag set than
   * fresh `codex exec`. Sandbox mode, working directory (`-C`), and
   * `--add-dir` are session-scoped and inherited from the original
   * session — passing them on resume causes the CLI to exit with
   * "unexpected argument '--sandbox' found". Fresh-session flags only
   * fire on the initial spawn (when `sessionId` is null).
   */
  _buildArgs(prompt) {
    const args = ["exec"];
    const resuming = !!this.sessionId;

    // Resume the prior thread if we captured one; else start fresh. The
    // CLI expects a raw UUID — strip our synthetic "codex-cli-" prefix.
    if (resuming) {
      args.push("resume", _unwrapSession(this.sessionId));
    }

    // Flags valid on both `exec` and `exec resume`.
    args.push("--json", "--skip-git-repo-check");

    // Fresh-session-only flags. Codex inherits sandbox + cwd from the
    // original session on resume; passing them again triggers a parse
    // error. (Codex CLI v0.128.0 confirmed: `--sandbox`, `-C`, and
    // `--add-dir` are rejected by `codex exec resume`.)
    if (!resuming) {
      args.push("--sandbox", _mapPermissionToSandbox(this.options.permissionMode));
      args.push("-C", this.cwd);
    }

    // Model IS accepted on both `exec` and `exec resume`, so we can
    // pass it either way. Useful for switching models mid-conversation.
    // Pass the resolved/coerced model (not raw options.model) so
    // unsupported ChatGPT-auth ids never reach codex's spawn.
    if (this.options.model) {
      args.push("-m", this.resolvedModel);
    }

    // Issue #39: filter out flags that belong to other providers
    // (Claude Code's --disable-slash-commands, --allowedTools, etc.)
    // so a multi-provider consumer can pass a shared extraArgs without
    // failing the codex spawn with "unexpected argument."
    if (this.options.extraArgs && Array.isArray(this.options.extraArgs)) {
      const { filterExtraArgs } = require("@gryphon/provider-config");
      const { filtered, dropped } = filterExtraArgs(this.options.extraArgs, "codex-cli");
      if (dropped.length > 0) {
        // Round 4 review (SFH-1): use console.error not warn — see
        // claude-code.js for the rationale. Louder is better when the
        // user-visible effect is "your flag was silently ignored."
        console.error(
          `[gryphon/codex-cli] Dropped ${dropped.length} cross-provider flag(s) ` +
          `from extraArgs: ${dropped.join(", ")}. Use options.extraProcessArgsByProvider ` +
          `for clean per-provider targeting.`,
        );
      }
      args.push(...filtered);
    }

    // Prompt as the trailing positional. Use `--` separator to prevent
    // a prompt that begins with `-` from being parsed as a flag.
    args.push("--", prompt);
    return args;
  }

  send(prompt) {
    return new Promise((resolve, reject) => {
      // Codex exec is one-shot. If a previous send is still in flight,
      // abort it — chat-view's supersede semantics expect the new turn
      // to take over cleanly.
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
      this._lastUsage = null;
      // QA1-1: reset _failed so a prior turn's fatal error doesn't
      // suppress this turn's _handleClose result-emit path.
      this._failed = false;
      // Track the prompt so _handleStaleSession can replay it on the
      // recovery path (when `codex exec resume <id>` reports "no
      // rollout found" — see _handleStaleSession for the full story).
      this._lastPrompt = prompt;
      // Reset the one-shot stale-recovery flag at the start of each
      // user-initiated send. A fresh send means a new chance to
      // recover if THIS turn's resume happens to be stale.
      this._staleRecoveryFired = false;

      // If the prior turn ended with a Gryphon protected-deny, the
      // session JSONL Codex resumes from contains the canonical deny
      // copy as a prior assistant message. Resuming would let the
      // model echo that copy on the next turn without ever calling
      // the tool again — to the user it looks like an "auto-deny"
      // because no modal appears (the hook never fires because the
      // model never tried). Force a fresh spawn instead. One-shot:
      // consumeTaintedSession removes the entry so subsequent turns
      // resume normally if no further deny occurs.
      const plugin = this.options.plugin;
      const rawSessionId = this.sessionId ? _unwrapSession(this.sessionId) : null;
      if (plugin && typeof plugin.consumeTaintedSession === "function" &&
          rawSessionId && plugin.consumeTaintedSession(rawSessionId)) {
        this.sessionId = null;
      }
      // Issue #33: parallel safety net keyed only by provider kind.
      // Robust to the cases the session_id-keyed taint misses (hook
      // input without session_id, Codex thread_id rotation across
      // resume, etc.). Either signal triggers a fresh spawn.
      if (plugin && typeof plugin.consumeForceFreshSpawn === "function" &&
          plugin.consumeForceFreshSpawn("codex-cli")) {
        this.sessionId = null;
      }

      const args = this._buildArgs(prompt);

      // HookDispatcher: install Gryphon's pre/post-tool-use hooks for
      // this spawn. On success, we get an env overlay (CODEX_HOME) that
      // makes Codex pick up our hook config. On degraded result we fall
      // through with no hooks and a console warning — the spawn still
      // proceeds so the user isn't blocked by transient setup issues.
      const hookExtras = dispatcher.prepareSpawn({
        kind: "codex-cli",
        plugin: this.options.plugin,
        options: this.options,
      });
      if (!hookExtras.ok && hookExtras.degradationReason) {
        console.warn(`[gryphon/codex-cli] hooks degraded: ${hookExtras.degradationReason}`);
      }
      this._hookCleanup = hookExtras.cleanup;

      // Merge any hook-supplied args at the end of argv. None today
      // (Codex picks up hooks via env), but the contract supports it.
      if (hookExtras.args && hookExtras.args.length > 0) {
        args.push(...hookExtras.args);
      }

      const spawnOpts = {
        cwd: this.cwd,
        env: {
          ...process.env,
          PATH: buildEnhancedPath(),
          ...(hookExtras.env || {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      };

      // Windows .cmd / .bat shim handling. Previously used shell:true,
      // which truncated multi-line prompts at the first newline because
      // cmd.exe interprets unquoted newlines as command terminators.
      // wrapForCmdShim builds the cmd.exe /c line ourselves with proper
      // CommandLineToArgvW quoting + windowsVerbatimArguments so the
      // [gryphon-context] block (multi-line) survives intact. Non-shim
      // (POSIX) path is unchanged.
      let spawnCommand = this.codexPath;
      let spawnArgs = args;
      if (winSpawn.isWindowsShim(this.codexPath)) {
        const wrapped = winSpawn.wrapForCmdShim(this.codexPath, args);
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
          console.error("CodexProvider: error processing event:", e);
        }
      }
    }
  }

  _processEvent(raw) {
    if (!raw || typeof raw !== "object") return;

    if (raw.type === "thread.started") {
      if (typeof raw.thread_id === "string" && raw.thread_id) {
        // Wrap with the synthetic prefix so chat-view's
        // filterMessagesForSave classifies this as a one-shot CLI
        // session (don't drop on save). Translation back to the raw id
        // happens in _buildArgs's resume path.
        this.sessionId = _wrapSession(raw.thread_id);
      }
      if (this.onMessage) this.onMessage("", "init");
      return;
    }

    if (raw.type === "item.started") {
      const item = raw.item || {};
      // Pattern enforcement now happens at the PreToolUse hook layer
      // via the HookDispatcher (v1.3 Stage 5). This branch only emits
      // the friendly tool-callback for chat-view rendering.
      if (item.type === "command_execution") {
        if (this.onMessage) this.onMessage("Bash", "tool");
      } else if (item.type === "file_change") {
        if (this.onMessage) this.onMessage("Edit", "tool");
      } else if (item.type === "web_search") {
        if (this.onMessage) this.onMessage("WebSearch", "tool");
      } else if (typeof item.type === "string" && item.type) {
        if (this.onMessage) this.onMessage(item.type, "tool");
      }
      return;
    }

    if (raw.type === "item.completed") {
      const item = raw.item || {};
      // The agent_message item carries the assistant's text response.
      // Codex emits it as a single completed item per turn (no streaming
      // deltas at the JSONL layer — the text is final at this point).
      if (item.type === "agent_message" && typeof item.text === "string") {
        const cleaned = _scrubInternalLeaks(item.text);
        this._turnText = cleaned;
        if (this.onMessage) this.onMessage(cleaned, "replace");
      }
      return;
    }

    if (raw.type === "turn.completed") {
      this._lastUsage = raw.usage || null;
      // Track context tokens — input_tokens reflects the full conversation
      // context the model saw on this turn. cached_input_tokens is a
      // subset of input_tokens (already counted), so we don't add it.
      if (this._lastUsage) {
        this.contextTokens = this._lastUsage.input_tokens || 0;
      }
      return;
    }

    if (raw.type === "error" || raw.type === "turn.failed") {
      const msg = (raw.error && raw.error.message) || raw.message || "Codex turn failed";

      // Stale-session recovery: Codex emits this exact-shaped error
      // when `codex exec resume <id>` is called with a thread that no
      // longer has a rollout file (session rotated out, vault wiped,
      // user ran `codex sessions clear`, etc.). Recover transparently
      // by dropping the stored session id and re-sending the prompt
      // as a fresh session — same recovery pattern claude-code uses
      // for "No conversation found with session ID". One-shot per
      // provider instance via `_staleRecoveryFired` so a second
      // failure doesn't loop.
      // User report 2026-05-03.
      if (/no rollout found for thread id/i.test(msg) && !this._staleRecoveryFired) {
        this._staleRecoveryFired = true;
        return this._handleStaleSession();
      }

      if (this.onError) this.onError(msg);
      // Mark the turn as failed so _handleClose doesn't ALSO reject
      // with its generic "ended without producing a response" wrapper
      // (code review V13-2: avoids double-error UX). The reject we
      // emit here carries the model's specific failure message; close
      // checks _failed and falls through to a no-op resolve path.
      const reject = this._currentReject;
      this._currentResolve = null;
      this._currentReject = null;
      this._failed = true;
      if (reject) reject(new Error(msg));
      return;
    }
  }

  /**
   * Stale-session recovery: re-send the most recent prompt as a
   * FRESH Codex session after `codex exec resume <id>` reported "no
   * rollout found". Mirrors ClaudeCodeProvider._handleStaleSession.
   *
   * Why this can happen:
   *   - User cleared their Codex sessions (`codex sessions clear`)
   *     between Gryphon turns
   *   - Codex rotated the rollout file out of its retention window
   *   - The persisted session id came from a corrupt/incomplete
   *     prior turn that never wrote a complete rollout to disk
   *
   * Recovery: kill the failed process, drop the session id (clearing
   * lastSessionId in the host's settings via onSessionExpired callback
   * so the NEXT process construction also doesn't read it back), and
   * re-spawn WITHOUT --resume. The user sees a brief delay; their
   * answer streams in normally.
   *
   * One-shot per provider instance — `_staleRecoveryFired` is set
   * before this runs. If the fresh spawn ALSO fails, the second
   * error surfaces normally.
   */
  _handleStaleSession() {
    // Kill the failed exec (if still running).
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch {}
      this.process = null;
    }
    this.alive = false;

    // Cleanup the per-spawn hook overlay since we're about to
    // re-spawn with a fresh one.
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch {}
      this._hookCleanup = null;
    }

    // Drop the stale session id. Future _buildArgs calls will produce
    // a fresh `codex exec` invocation (no `resume` subcommand).
    this.sessionId = null;
    this.options.resumeSessionId = undefined;

    // Tell the host (chat-view) to clear its persisted lastSessionId.
    // Without this, the NEXT provider constructed by the factory
    // would re-read the stale id from settings and fail the same way.
    if (typeof this.onSessionExpired === "function") {
      try { this.onSessionExpired(); } catch {}
    }

    // Re-send the user's prompt. send() supersede-kills any in-flight
    // process (already null'd above) and starts fresh. The pending
    // resolve/reject from the original send() call will fire when the
    // fresh session produces its result.
    const prompt = this._lastPrompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      // We can't call this.send(prompt) directly because that returns
      // a NEW Promise — the original caller is still awaiting our
      // ORIGINAL send()'s Promise. Hook the new spawn's lifecycle to
      // the original pending resolve/reject by NOT clearing them
      // before the re-spawn, and letting the new spawn's events
      // resolve/reject the original Promise.
      const origResolve = this._currentResolve;
      const origReject = this._currentReject;
      // Reset per-turn buffers (matches send() per-turn reset).
      this._buffer = "";
      this._stderrTail = "";
      this._turnText = "";
      this._lastUsage = null;
      this._failed = false;

      // V13H-2: hoist the orig-promise reattachment OUT of the
      // microtask body. JS event-loop semantics (microtasks run
      // before macrotasks) make a user-driven send() impossible to
      // slip into the gap, but a synchronous re-entry from an
      // onError handler that calls provider.send() directly WOULD
      // overwrite _currentResolve before our microtask reasserted it.
      // Reasserting them synchronously here closes that fragility.
      // _respawnFresh below still dispatches via microtask so we
      // unwind the current event handler before spawn-logic re-enters.
      this._currentResolve = origResolve;
      this._currentReject = origReject;

      // Re-spawn using the same lifecycle send() would have produced.
      // Internally re-creates the hook overlay and the spawn argv,
      // resolving/rejecting the same outer Promise on completion.
      // Use a small async dispatch so we return cleanly from the
      // event handler before re-entering spawn logic.
      Promise.resolve().then(() => {
        try {
          this._respawnFresh(prompt);
        } catch (e) {
          if (origReject) origReject(e);
        }
      });
    } else {
      // No prompt to retry — surface a generic stale-session error.
      const reject = this._currentReject;
      this._currentResolve = null;
      this._currentReject = null;
      if (reject) reject(new Error(
        "Codex resumed a session that no longer has a rollout on disk. " +
        "Try the request again — Gryphon has cleared the stale session id."
      ));
    }
  }

  /**
   * Internal helper: spawn a fresh codex exec (no --resume) for the
   * given prompt. Used only by _handleStaleSession's recovery path.
   * The pending Promise hooks (_currentResolve / _currentReject)
   * MUST already be set to the original send()'s callbacks.
   */
  _respawnFresh(prompt) {
    const { hookDispatcher: dispatcher } = require("@gryphon/protect");
    const hookExtras = dispatcher.prepareSpawn({
      kind: "codex-cli",
      plugin: this.options.plugin,
      options: this.options,
    });
    if (!hookExtras.ok && hookExtras.degradationReason) {
      console.warn(`[gryphon/codex-cli] hooks degraded on stale-session retry: ${hookExtras.degradationReason}`);
    }
    this._hookCleanup = hookExtras.cleanup;

    const args = this._buildArgs(prompt);
    if (hookExtras.args && hookExtras.args.length > 0) {
      args.push(...hookExtras.args);
    }

    const spawnOpts = {
      cwd: this.cwd,
      env: {
        ...process.env,
        PATH: buildEnhancedPath(),
        ...(hookExtras.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    };

    // Same Windows .cmd shim handling as send() — see wrapForCmdShim docs.
    let spawnCommand = this.codexPath;
    let spawnArgs = args;
    if (winSpawn.isWindowsShim(this.codexPath)) {
      const wrapped = winSpawn.wrapForCmdShim(this.codexPath, args);
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

  _handleStderr(data) {
    const text = data.toString();
    if (!text) return;
    // Keep last 4 KB for surfacing on close.
    this._stderrTail = (this._stderrTail + text).slice(-4096);

    // Codex prints initial banners and skill-load warnings to stderr —
    // those are not user-facing errors. Only forward lines that look
    // like real errors. The `ERROR codex_core::` prefix is Rust tracing
    // and is usually noise (skill YAML load warnings, etc.).
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/Reading additional input from stdin/i.test(trimmed)) return;
    if (/^[\d:T.Z-]+\s+ERROR codex_core::session: failed to load skill/i.test(trimmed)) return;

    // Auth failure detection — surface to chat-view as a clean error
    // rather than an opaque exit code.
    if (/not logged in|run [`'"]?codex login|authentication failed/i.test(trimmed)) {
      if (this.onError) this.onError(
        "Codex CLI is not logged in. Run `codex login` in a terminal, then retry."
      );
      return;
    }
  }

  _handleClose(code) {
    this.alive = false;
    this.process = null;
    if (this._hookCleanup) {
      try { this._hookCleanup(); } catch (e) {
        console.warn(`[gryphon/codex-cli] hook cleanup failed: ${e.message}`);
      }
      this._hookCleanup = null;
    }

    // If a JSONL `error` / `turn.failed` event already rejected the
    // pending promise (V13-2 path), don't emit a second close-time
    // error. The model's specific failure message is more useful than
    // "ended without producing a response" — preserve it.
    if (this._failed) {
      this._failed = false;
      return;
    }

    // Stale-session recovery (close-time variant). When `codex exec
    // resume <id>` fails because the rollout file is gone, Codex
    // doesn't emit a JSONL `error` event — it writes the error to
    // stderr and exits with code 1, no events streamed. The
    // `_processEvent` recovery in this provider only fires for
    // JSONL events; we ALSO need to detect stderr-shaped failures
    // here. Same recovery pattern: drop the stale session id, fire
    // onSessionExpired so chat-view clears the persisted id, and
    // re-spawn fresh with the captured prompt.
    // User report 2026-05-03 (round 2 — first patch only handled
    // the JSONL-event path, missed the stderr-only path).
    if (
      code !== 0 &&
      !this._staleRecoveryFired &&
      /no rollout found for thread id/i.test(this._stderrTail || "")
    ) {
      this._staleRecoveryFired = true;
      return this._handleStaleSession();
    }

    // Resolve only if we haven't already (a successful turn.completed
    // event will have set _lastUsage; an empty close means the CLI
    // exited without producing a result, which is an error).
    const resolve = this._currentResolve;
    const reject = this._currentReject;
    this._currentResolve = null;
    this._currentReject = null;
    if (!resolve) return;

    if (code === 0 && this._lastUsage) {
      // Compute cost from token counts using OpenAI pricing tables.
      // Codex's `usage` shape doesn't directly match chat.completions —
      // map it before computing.
      const mappedUsage = {
        prompt_tokens: this._lastUsage.input_tokens || 0,
        completion_tokens: this._lastUsage.output_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: this._lastUsage.cached_input_tokens || 0,
        },
      };
      const { cost } = computeCost(mappedUsage, this.resolvedModel);
      this.lastCumulativeCost += cost;

      const result = {
        text: this._turnText || "",
        cost,
        cumulativeCost: this.lastCumulativeCost,
        sessionId: this.sessionId,
        duration: 0,
        contextTokens: this.contextTokens,
      };
      if (this.onDone) this.onDone(result);
      resolve(result);
      return;
    }

    // Failure path. Surface stderr tail so users have something
    // actionable. This matches the claude-code provider's pattern.
    const stderr = (this._stderrTail || "").trim();
    const tail = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join("\n");
    const header = code === 0
      ? "Codex CLI ended without producing a response."
      : `Codex CLI exited unexpectedly (exit code ${code}).`;
    const details = tail ? `\n\nDetails from Codex:\n${tail}` : "";
    const hint =
      "\n\nCommon causes: not logged in (`codex login`), the prompt was " +
      "rejected by the sandbox, or a transient API error. Try again, or " +
      "run `codex exec --json -- 'hello'` in a terminal to verify the CLI " +
      "is working.";
    reject(new Error(header + details + hint));
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

  // Cost is estimated from token counts × OpenAI pricing tables. The CLI
  // does not return USD directly (it can't on a ChatGPT subscription
  // path; the API path would be different), so the figure is an estimate.
  get costIsEstimate() { return true; }
}

module.exports = {
  CodexProvider,
  _mapPermissionToSandbox,
  _supportsLandlockSandbox,
  _wrapSession,
  _unwrapSession,
  _scrubInternalLeaks,
  SESSION_PREFIX,
  DEFAULT_MODEL,
};
