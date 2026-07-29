"use strict";
/**
 * AntigravityCliProvider — implements the LLMProvider contract via the
 * Google Antigravity CLI (`agy`). Each `send()` spawns a fresh
 * `agy -p ... --output-format stream-json --dangerously-skip-permissions`
 * process, parses its JSONL event stream to EOF, and resolves with the
 * final result.
 *
 * Why this provider exists (issue #19): Google cut the `gemini` CLI off
 * the Gemini Code Assist individuals tier (2026-06-18 for Pro/Ultra,
 * 2026-07-27 evidence shows the same shutdown reaching individuals) and
 * is redirecting free-tier users to the Antigravity suite, which ships
 * its own CLI. GeminiCliProvider now detects the resulting
 * `UNSUPPORTED_CLIENT` failure and points users here.
 *
 * One-shot per turn (like CodexProvider/GeminiCliProvider, unlike
 * claude-code's persistent stdin loop).
 *
 * CORRECTION (2026-07-28): the original issue #19 implementation was
 * written without access to a real `agy` binary and assumed its flags
 * and event stream mirrored gemini-cli's. That assumption was WRONG,
 * verified live against a real, authenticated `agy` v1.1.8 install:
 *   - `--yes` and `--no-color` do not exist (`agy --help` lists neither);
 *     passing them exits 2 with usage text on stderr, so every single
 *     call under the old code failed outright.
 *   - `-o` is not a valid short form of `--output-format` (only `-p`,
 *     `-i`, `-c` have short aliases); `-m` is likewise not a valid short
 *     form of `--model`.
 *   - `--resume <id>` does not exist; the real resume flag is
 *     `--conversation <id>`.
 *   - The event stream shape is entirely different from gemini-cli's —
 *     see below. This provider now parses the REAL shape.
 * The wrong flags and wrong event shape are fixed below; behavior,
 * error handling, and the outward send()/cost/session contract are
 * otherwise unchanged.
 *
 * Auth: unlike gemini-cli (API-key-in-env), Antigravity docs describe
 * silent keyring auth on local machines or an OAuth flow for remote/SSH
 * sessions, handled entirely by the CLI itself (mirrors codex-cli's
 * `codex login` model) — Gryphon never touches credentials here. Live
 * testing only exercised an ALREADY-authenticated CLI; the exact
 * unauthenticated-invocation behavior (e.g. whether it prints an OAuth
 * URL and hangs, or fails fast) remains UNVERIFIED against a real run —
 * `_handleStderr`'s auth-missing regex below is still a best-effort
 * guess, not a confirmed error string.
 *
 * Sandbox / approval: no documented per-call approval-mode flag exists
 * for `agy` (unlike gemini's `--approval-mode`), so this provider always
 * passes `--dangerously-skip-permissions` (verified real flag name,
 * confirmed via `init.permission_mode: "always-proceed"` on a live
 * response vs `"request-review"` without it) to auto-approve — the
 * alternative is a headless hang waiting on interactive confirmation.
 * Gryphon's PreToolUse hook IS the enforcement layer here (adapter:
 * `packages/protect/src/hook-adapters/antigravity-cli.ts`). Verified live
 * against agy v1.1.8: a hook `deny` hard-blocks the tool even with
 * `--dangerously-skip-permissions` set, which is what makes auto-approve
 * safe to pass. Note that agy treats a CRASHED hook as allow, so the
 * adapter bakes the hook env into the command rather than relying on spawn
 * inheritance — see its header.
 *
 * Known sharp edges (issue #19, carried into this implementation):
 *   - Headless reliability is not yet solid upstream. A community
 *     wrapper, agy-headless (https://gist.github.com/allahsan/
 *     a9a9e9c8a49aecede67ce974e64ef3cf), works around stdin hangs and
 *     silent stdout/stderr by reading results out of `agy`'s
 *     conversation SQLite store. Upstream antigravity-cli#7
 *     (https://github.com/google-antigravity/antigravity-cli/issues/7)
 *     tracks emitting per-conversation IDs for headless callers.
 *     `--conversation <id>` resume IS confirmed to work against the real
 *     CLI (verified live: a second `-p` call with `--conversation
 *     <conversation_id>` from a prior turn's `result` event continued
 *     the same conversation, with step_index continuing from where the
 *     prior turn left off) — this is no longer speculative.
 *   - `--model` requires a companion `--effort low|medium|high` for SOME
 *     models (verified: Gemini models error `--model ... requires
 *     --effort`) while OTHER models reject `--effort` outright (verified:
 *     Claude models on the same CLI error `--effort is not supported for
 *     model ...`). This is a genuine per-model CLI inconsistency, not
 *     something Gryphon can resolve by guessing — `_buildArgs` below only
 *     adds `--effort` when the caller explicitly supplies
 *     `options.effort` (mirrors claude-code.ts's existing pattern); it
 *     does not inject a default.
 *   - Free-tier quota limits are not published.
 *   - A hard client-side timeout (`_watchdog` below) guards against the
 *     documented stdin-hang failure mode — this provider does NOT rely
 *     solely on the host's outer connection timeout, because that surfaces
 *     a generic "no response" message rather than this provider's
 *     specific, actionable one.
 *
 * Event stream (JSONL on stdout, VERIFIED live against `agy` v1.1.8,
 * authenticated, `--output-format stream-json`). Nothing below is
 * inferred or ported from gemini-cli — every shape was observed from a
 * real invocation:
 *
 *   { event: "init", conversation_id, init: { cwd, tools: [...],
 *     permission_mode: "request-review"|"always-proceed" } }
 *     — first line of every turn. No `model` field is present (unlike
 *     gemini-cli's init event), so this provider cannot learn the
 *     resolved model from the stream; `resolvedModel` stays whatever
 *     `coerceToVendorModel(options.model)` produced at construction.
 *
 *   { event: "step_update", step_update: { conversation_id, step_index,
 *     state: "ACTIVE"|"DONE", step_type, text_delta?, tool_name?,
 *     tool_info?, duration_seconds?, usage? } }
 *     — the bulk of the stream. `step_type` observed values:
 *       - "user_input"     — echo of the prompt; no text, ignored.
 *       - "unknown"        — a fast (~0.5ms) internal bookkeeping step
 *                            with no payload; ignored.
 *       - "agent_response" — carries the assistant's visible text via
 *                            `text_delta`, split across an ACTIVE event
 *                            (partial delta, e.g. "OK") and a DONE event
 *                            for the SAME step_index (the trailing delta,
 *                            e.g. "\n", plus `usage`). Deltas are
 *                            INCREMENTAL — concatenating every
 *                            `text_delta` seen (in arrival order) across
 *                            ALL agent_response step_updates in a turn
 *                            reconstructs the exact final text (confirmed
 *                            byte-for-byte against the terminal `result`
 *                            event's `response` field in every probe run,
 *                            including a multi-step tool-use turn).
 *       - "tool"           — a tool invocation. ACTIVE carries
 *                            `tool_name` + `tool_info.parameters`; DONE
 *                            (same step_index) adds `tool_info.output`.
 *                            No `text_delta`.
 *       - "checkpoint"     — periodic internal step with `usage` but no
 *                            text; ignored.
 *       - "system_message" / "finish" — observed on multi-turn/
 *                            structured-output runs, no payload beyond
 *                            state; ignored.
 *
 *   { event: "result", result: { conversation_id, status: "SUCCESS"|
 *     "ERROR", response, error?, duration_seconds, num_turns, usage:
 *     { input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 *     total_tokens }, structured_output?, json_schema? } }
 *     — always the LAST stdout line. On "SUCCESS", `response` is the
 *     complete final text (authoritative — used to override the
 *     step_update-accumulated text as a belt-and-suspenders check).
 *     On "ERROR" (verified live via an invalid --model probe), `response`
 *     is empty and `error` carries a human-readable message; the process
 *     also exits non-zero (observed: exit 1). Unlike gemini-cli's
 *     `error` event, there is no separate mid-stream error event and no
 *     severity/warning concept — the terminal `result.status` is the
 *     only fatal/non-fatal signal this CLI emits.
 *
 * `usage` field names differ from gemini-cli's `stats`: `cached` becomes
 * `cache_read_tokens`, and `thinking_tokens` is a new field gemini-cli's
 * `stats` shape doesn't have (folded into computeCost's existing
 * candidatesTokenCount mapping below rather than tracked separately,
 * since @gryphon/provider-config's google pricing table has no
 * thinking-token-specific rate).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HARD_TIMEOUT_MS = exports.DEFAULT_MODEL = exports.SESSION_PREFIX = exports.AntigravityCliProvider = void 0;
exports._wrapSession = _wrapSession;
exports._unwrapSession = _unwrapSession;
exports._scrubInternalLeaks = _scrubInternalLeaks;
// These run in both the Obsidian renderer and headless Node paths (CLI probes,
// passive backend, hook/IPC subprocess) where `window` is unavailable, so bind
// the ambient timer global to a module-local. obsidianmd/prefer-window-timers
// accepts timer names that resolve to a local binding; window.* would throw in
// the headless paths.
const setTimeoutFn = setTimeout;
const clearTimeoutFn = clearTimeout;
const { managedSpawn, killProcessTree } = require("../../subprocess-registry");
const { buildEnhancedPath, resolveCliBinary } = require("../../utils");
const { computeCost, coerceToVendorModel, DEFAULT_MODEL, } = require("@gryphon/provider-config").pricing.google;
exports.DEFAULT_MODEL = DEFAULT_MODEL;
const { hookDispatcher: dispatcher } = require("@gryphon/protect");
const { winSpawn } = require("@gryphon/protect");
// Default hard client-side timeout for a single `agy` turn. Antigravity's
// documented sharp edge is a headless stdin hang with silent stdout/stderr
// (issue #19 "Known sharp edges") — without an internal watchdog, that
// hang would only surface via the HOST's outer connection timeout (often
// 90-180s) with a generic "no response" message that gives the user no
// actionable signal. 60s is generous for a trivial completion while still
// firing well before a typical host connection timeout, so the user sees
// THIS provider's specific, actionable message first. Overridable per-spawn
// via `options.antigravityTimeoutMs` (e.g. for a longer-running agentic turn).
const DEFAULT_HARD_TIMEOUT_MS = 60000;
exports.DEFAULT_HARD_TIMEOUT_MS = DEFAULT_HARD_TIMEOUT_MS;
// Synthetic prefix tagged onto session IDs we hand back to chat-view — see
// CodexProvider.SESSION_PREFIX for the rationale. Distinguishes a one-shot
// CLI session (chat-history.json is canonical) from a Claude-Code-style
// session (history re-supplied by the CLI on resume).
const SESSION_PREFIX = "antigravity-cli-";
exports.SESSION_PREFIX = SESSION_PREFIX;
// Foreign provider prefixes — see codex-cli.ts for the rationale.
const FOREIGN_PREFIX_RE = /^(sdk|openai-sdk|gemini-sdk|codex-cli|gemini-cli)-/;
function _wrapSession(id) {
    if (!id)
        return null;
    if (typeof id !== "string")
        return null;
    if (FOREIGN_PREFIX_RE.test(id))
        return null;
    if (id.startsWith(SESSION_PREFIX))
        return id;
    return SESSION_PREFIX + id;
}
function _unwrapSession(id) {
    if (typeof id !== "string")
        return id;
    if (id.startsWith(SESSION_PREFIX))
        return id.slice(SESSION_PREFIX.length);
    return id;
}
/**
 * Strip Antigravity-side internal-mechanism leaks from the model's
 * user-facing text. Mirrors gemini-cli's `_scrubInternalLeaks` /
 * codex-cli's copy. Load-bearing now that this provider has a real hook
 * adapter: a PreToolUse deny surfaces Gryphon's reason to the model, and
 * without this scrub the model echoes the mechanism vocabulary back to the
 * user (see `feedback_public_release_wording`).
 */
function _scrubInternalLeaks(text) {
    if (typeof text !== "string" || !text)
        return text;
    let out = text;
    out = out.replace(/^(?:[\s>]*)?Command blocked by [A-Za-z]*Tool[a-zA-Z]* hook:\s*/gim, "");
    out = out.replace(/\s*\((?:via|by|using|through)\s+[^)]*hook[^)]*\)/gi, "");
    const _stripTrailerIfSafe = (s) => {
        const m = s.match(/(?:^|\n)\s*Command:\s+[\s\S]+$/i);
        if (!m)
            return s;
        const tail = s.slice(m.index);
        if (tail.includes("```"))
            return s;
        return s.slice(0, m.index);
    };
    out = _stripTrailerIfSafe(out);
    const _stripInlineTrailerIfSafe = (s) => {
        const m = s.match(/\.[ \t]+Command:\s+[\s\S]+$/i);
        if (!m)
            return s;
        const tail = s.slice(m.index);
        if (tail.includes("```"))
            return s;
        return s.slice(0, m.index) + ".";
    };
    out = _stripInlineTrailerIfSafe(out);
    if (!out.includes("```")) {
        out = out.replace(/\n+\s*Command:\s+`?(?:rm|del|erase|unlink|shred)[^\n]*\n*/i, "\n\n");
    }
    return out.trim();
}
class AntigravityCliProvider {
    constructor(antigravityPath, cwd, options = {}) {
        // Test-harness options-bag form: AntigravityCliProvider({ config, hostAdapter,
        // _spawnOverride }) — no antigravityPath or cwd required. The _spawnOverride
        // function replaces the real CLI spawn for unit tests.
        if (antigravityPath && typeof antigravityPath === "object" && !cwd) {
            const bag = antigravityPath;
            antigravityPath = bag.antigravityPath || "";
            cwd = bag.cwd || "";
            options = {
                model: bag.config && bag.config.model,
                hostAdapter: bag.hostAdapter,
                _spawnOverride: bag._spawnOverride,
            };
        }
        this.antigravityPath = antigravityPath;
        this.cwd = cwd;
        this.options = options;
        // _spawnOverride: a function (prompt) => Promise<{text, sessionId, cost,
        // contextTokens, ...}> injected by tests to replace the real CLI spawn.
        this._spawnOverride = options._spawnOverride || null;
        this.hostAdapter = options.hostAdapter ||
            new (require("../../host-adapter").HeadlessHostAdapter)();
        this.process = null;
        this.alive = false;
        this.sessionId = _wrapSession(options.resumeSessionId) || null;
        // Antigravity is the Gemini-based Antigravity suite (per issue #19),
        // so it reuses the google pricing table + model coercion — same as
        // GeminiCliProvider.
        this.resolvedModel = coerceToVendorModel(options.model);
        this.contextTokens = 0;
        this.lastCumulativeCost = 0;
        this._buffer = "";
        this._stderrTail = "";
        this._turnText = "";
        this._lastResult = null;
        this._currentResolve = null;
        this._currentReject = null;
        this._watchdog = null;
        this.onMessage = null;
        this.onError = null;
        this.onDone = null;
        this.onSessionExpired = null;
    }
    _buildArgs(prompt) {
        // No documented per-call approval-mode flag exists for `agy` (unlike
        // gemini's `--approval-mode`). `--dangerously-skip-permissions`
        // (verified real flag name — `agy --help` has no `--yes`/`--no-color`
        // at all) auto-approves so a headless spawn never blocks waiting on
        // an interactive confirmation prompt. `--output-format stream-json`
        // is the verified long-form flag (`-o` is not a valid short alias —
        // only `-p`/`-i`/`-c` have short forms per `agy --help`).
        const args = [
            "-p", prompt,
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
        ];
        if (this.options.model) {
            // `-m` is not a valid short form (verified: errors "flags provided
            // but not defined: -m") — the real flag is `--model`. Some models
            // additionally REQUIRE a companion `--effort`; others REJECT it —
            // see header "Known sharp edges". Only forward it when the caller
            // explicitly set one; we don't guess a default.
            args.push("--model", this.options.model);
            if (this.options.effort) {
                args.push("--effort", this.options.effort);
            }
        }
        // Resume the prior conversation if we captured one; else start fresh.
        // `--conversation <id>` is the verified real resume flag (`--resume`
        // does not exist on this CLI) — confirmed live: a second `-p` call
        // with `--conversation <id>` continued the same conversation with
        // step_index picking up where the prior turn left off.
        if (this.sessionId) {
            args.push("--conversation", _unwrapSession(this.sessionId));
        }
        // Issue #39-style cross-provider flag filtering — same contract the
        // other three CLI providers use, so a multi-provider consumer can pass
        // a shared extraArgs without failing this spawn on another CLI's flags.
        if (this.options.extraArgs && Array.isArray(this.options.extraArgs)) {
            const { filterExtraArgs } = require("@gryphon/provider-config");
            const { filtered, dropped } = filterExtraArgs(this.options.extraArgs, "antigravity-cli");
            if (dropped.length > 0) {
                console.error(`[gryphon/antigravity-cli] Dropped ${dropped.length} cross-provider flag(s) ` +
                    `from extraArgs: ${dropped.join(", ")}. Use options.extraProcessArgsByProvider ` +
                    `for clean per-provider targeting.`);
            }
            args.push(...filtered);
        }
        return args;
    }
    _buildEnv() {
        // No API key to forward — Antigravity docs describe silent keyring
        // auth (local) or an OAuth flow (remote/SSH), both owned by the CLI
        // itself. Mirrors codex-cli's `_buildEnv` (PATH only).
        return { ...process.env, PATH: buildEnhancedPath() };
    }
    send(prompt, options) {
        if (options && typeof options.maxUsdBudget === "number" && (!(options.maxUsdBudget > 0) || !isFinite(options.maxUsdBudget))) {
            throw new RangeError(`maxUsdBudget must be positive (got ${options.maxUsdBudget})`);
        }
        // R7 cancellation: route a consumer AbortSignal to abort() so the child
        // process tree is reaped promptly. abort() is idempotent and tree-kills.
        if (options && options.signal) {
            if (options.signal.aborted)
                return Promise.reject(new Error("Aborted"));
            if (typeof options.signal.addEventListener === "function") {
                options.signal.addEventListener("abort", () => { try {
                    this.abort();
                }
                catch { } }, { once: true });
            }
        }
        // L6.1 — structured-output retry budget for CLI providers. Identical
        // shape to GeminiCliProvider/CodexProvider.
        if (options && options.structuredOutput) {
            const { injectSchemaHint, parseAndValidate, CliStructuredOutputError, } = require("../../cli-structured-output");
            const maxRetries = options.structuredOutput.maxRetries ?? 3;
            const enrichedPrompt = injectSchemaHint(prompt, options.structuredOutput);
            const savedOnDone = this.onDone;
            this.onDone = null;
            const loop = async () => {
                let lastError = null;
                const priorCallCumulative = this.lastCumulativeCost;
                try {
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        const turnResult = await this._spawnTurn(enrichedPrompt);
                        if (this._spawnOverride)
                            this.lastCumulativeCost = turnResult.cumulativeCost || 0;
                        if (options && typeof options.maxUsdBudget === "number") {
                            const cumCost = typeof turnResult.cumulativeCost === "number" ? turnResult.cumulativeCost : null;
                            if (cumCost === null) {
                                this.hostAdapter && this.hostAdapter.notify && this.hostAdapter.notify(`[gryphon] CLI provider did not report cumulativeCost; budget guard cannot verify spend`, { level: "warn" });
                            }
                            const perCallSpent = cumCost !== null ? cumCost - priorCallCumulative : 0;
                            if (perCallSpent >= options.maxUsdBudget) {
                                const { BudgetExceededError } = require("../../budget-error");
                                throw new BudgetExceededError({
                                    budget: options.maxUsdBudget,
                                    spent: perCallSpent,
                                    lastTurnCost: turnResult.cost || 0,
                                });
                            }
                        }
                        try {
                            const json = parseAndValidate(turnResult.text, options.structuredOutput.schema);
                            const result = { ...turnResult, json, text: JSON.stringify(json) };
                            this.onDone = savedOnDone;
                            if (this.onDone)
                                this.onDone(result);
                            return result;
                        }
                        catch (e) {
                            if (!(e instanceof CliStructuredOutputError))
                                throw e;
                            lastError = e;
                            try {
                                this.hostAdapter.notify(`[gryphon] structured-output attempt ${attempt}/${maxRetries} failed: ${e.reason}`, { level: "warn" });
                            }
                            catch (_) { /* notify must never block */ }
                        }
                    }
                    throw new CliStructuredOutputError(`structured-output budget exhausted after ${maxRetries} attempts on antigravity-cli: ${lastError && lastError.message}`, {
                        reason: "budget-exhausted",
                        attempts: maxRetries,
                        lastOutput: lastError && lastError.lastOutput,
                    });
                }
                finally {
                    this.onDone = savedOnDone;
                }
            };
            return loop();
        }
        // Plain (non-structured-output) path.
        if (options && typeof options.maxUsdBudget === "number") {
            const priorCallCumulative = this.lastCumulativeCost;
            return this._spawnTurn(prompt).then((result) => {
                if (this._spawnOverride)
                    this.lastCumulativeCost = result.cumulativeCost || 0;
                const cumCost = typeof result.cumulativeCost === "number" ? result.cumulativeCost : null;
                if (cumCost === null) {
                    this.hostAdapter && this.hostAdapter.notify && this.hostAdapter.notify(`[gryphon] CLI provider did not report cumulativeCost; budget guard cannot verify spend`, { level: "warn" });
                }
                const perCallSpent = cumCost !== null ? cumCost - priorCallCumulative : 0;
                if (perCallSpent >= options.maxUsdBudget) {
                    const { BudgetExceededError } = require("../../budget-error");
                    throw new BudgetExceededError({
                        budget: options.maxUsdBudget,
                        spent: perCallSpent,
                        lastTurnCost: result.cost || 0,
                    });
                }
                return result;
            });
        }
        return this._spawnTurn(prompt);
    }
    /**
     * Execute one `agy -p` turn and return a Promise that resolves with the
     * result object {text, cost, cumulativeCost, sessionId, duration,
     * contextTokens}. When _spawnOverride is set (test-harness injection),
     * delegates directly to the override function.
     */
    _spawnTurn(prompt) {
        if (this._spawnOverride) {
            return this._spawnOverride(prompt);
        }
        // Preflight (R1/R4/R5): resolve to the newest valid agy binary,
        // self-heal a stale/empty configured path, or fail fast with an
        // actionable message rather than spawning an unresolved path and
        // hanging to the connection timeout.
        {
            const resolved = resolveCliBinary("antigravity-cli", this.antigravityPath);
            if (!resolved.ok) {
                const msg = resolved.error === "too-old"
                    ? `Found ${resolved.detail}. Update the Antigravity CLI, or set a newer path in Settings → Gryphon → Antigravity CLI path.`
                    : "Antigravity CLI not found. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or set the full path in Settings → Gryphon → Antigravity CLI path.";
                return Promise.reject(new Error(msg));
            }
            this.antigravityPath = resolved.path; // self-heal to the newest valid binary
        }
        return new Promise((resolve, reject) => {
            // Supersede an in-flight turn — same shape as CodexProvider/GeminiCliProvider.
            if (this.alive && this.process) {
                try {
                    killProcessTree(this.process, "SIGTERM");
                }
                catch { }
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
            this._lastResult = null;
            this._failed = false;
            this._lastPrompt = prompt;
            this._staleRecoveryFired = false;
            const plugin = this.options.plugin;
            const rawSessionId = this.sessionId ? _unwrapSession(this.sessionId) : null;
            if (plugin && typeof plugin.consumeTaintedSession === "function" &&
                rawSessionId && plugin.consumeTaintedSession(rawSessionId)) {
                this.sessionId = null;
            }
            if (plugin && typeof plugin.consumeForceFreshSpawn === "function" &&
                plugin.consumeForceFreshSpawn("antigravity-cli")) {
                this.sessionId = null;
            }
            // HookDispatcher: the "antigravity-cli" adapter installs Gryphon's
            // PreToolUse gate into the global hooks.json and removes it on close,
            // so this always returns a degraded result. Calling it anyway keeps
            // this provider structurally symmetric with the other three and
            // means it picks up hook support automatically the day an adapter
            // lands, with zero changes here.
            const hookExtras = dispatcher.prepareSpawn({
                kind: "antigravity-cli",
                plugin: this.options.plugin,
                options: this.options,
            });
            if (!hookExtras.ok && hookExtras.degradationReason) {
                console.warn(`[gryphon/antigravity-cli] hooks degraded: ${hookExtras.degradationReason}`);
            }
            this._hookCleanup = hookExtras.cleanup;
            const args = this._buildArgs(prompt);
            if (hookExtras.args && hookExtras.args.length > 0) {
                args.push(...hookExtras.args);
            }
            const spawnOpts = {
                cwd: this.cwd,
                env: { ...this._buildEnv(), ...(hookExtras.env || {}) },
                // stdin "ignore" closes stdin from the child's perspective (same
                // as redirecting from /dev/null) — required per issue #19: `agy`
                // otherwise blocks waiting on input in headless mode.
                stdio: ["ignore", "pipe", "pipe"],
            };
            let spawnCommand = this.antigravityPath;
            let spawnArgs = args;
            if (winSpawn.isWindowsShim(this.antigravityPath)) {
                const wrapped = winSpawn.wrapForCmdShim(this.antigravityPath, args);
                spawnCommand = wrapped.command;
                spawnArgs = wrapped.args;
                Object.assign(spawnOpts, wrapped.options);
            }
            let proc;
            try {
                proc = managedSpawn(spawnCommand, spawnArgs, spawnOpts, { label: "antigravity-cli" });
            }
            catch (err) {
                if (this._hookCleanup) {
                    this._hookCleanup();
                    this._hookCleanup = null;
                }
                reject(err);
                return;
            }
            this.process = proc;
            this.alive = true;
            const forThis = () => this.process === proc;
            proc.stdout.on("data", (data) => { if (forThis())
                this._handleStdout(data); });
            proc.stderr.on("data", (data) => { if (forThis())
                this._handleStderr(data); });
            proc.on("close", (code) => { if (forThis())
                this._handleClose(code); });
            proc.on("error", (err) => { if (forThis())
                this._handleProcessError(err); });
            // Hard client-side timeout (issue #19 — "no silent hang to the
            // connection timeout"). Antigravity's documented sharp edge is a
            // headless stdin hang with silent stdout/stderr; without this, the
            // failure would only ever surface via the HOST's outer connection
            // timeout with a generic message. Cleared on close/error/abort.
            const timeoutMs = (typeof this.options.antigravityTimeoutMs === "number" && this.options.antigravityTimeoutMs > 0)
                ? this.options.antigravityTimeoutMs
                : DEFAULT_HARD_TIMEOUT_MS;
            this._watchdog = setTimeoutFn(() => {
                if (!forThis() || !this.alive)
                    return;
                const err = new Error(`Antigravity CLI did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
                    "Headless reliability for agy is not yet fully solid upstream " +
                    "(tracked: https://github.com/google-antigravity/antigravity-cli/issues/7). " +
                    "Try again, or switch Provider in Settings → Gryphon.");
                try {
                    killProcessTree(proc, "SIGTERM");
                }
                catch { }
                setTimeoutFn(() => { try {
                    killProcessTree(proc, "SIGKILL");
                }
                catch { } }, 5000);
                this.process = null;
                this.alive = false;
                if (this._hookCleanup) {
                    try {
                        this._hookCleanup();
                    }
                    catch { }
                    this._hookCleanup = null;
                }
                const rej = this._currentReject;
                this._currentResolve = null;
                this._currentReject = null;
                this._failed = true; // suppress a duplicate close-time reject
                if (rej)
                    rej(err);
            }, timeoutMs);
        });
    }
    _clearWatchdog() {
        if (this._watchdog) {
            try {
                clearTimeoutFn(this._watchdog);
            }
            catch { }
            this._watchdog = null;
        }
    }
    _handleStdout(data) {
        this._buffer += data.toString();
        const lines = this._buffer.split("\n");
        this._buffer = lines.pop() || "";
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                this._processEvent(parsed);
            }
            catch (e) {
                if (!(e instanceof SyntaxError)) {
                    console.error("AntigravityCliProvider: error processing event:", e);
                }
            }
        }
    }
    _processEvent(raw) {
        if (!raw || typeof raw !== "object")
            return;
        // Real wire shape (verified live against agy v1.1.8 — see header):
        // every line has a top-level `event` name with a same-named nested
        // payload object, NOT gemini-cli's flat `type` discriminator.
        if (raw.event === "init") {
            // raw.init carries { cwd, tools, permission_mode } — none of it is
            // consumed here. No `model` field is ever present on the real init
            // payload — do NOT try to read one (the old code's `raw.model` read
            // here was gemini-cli-shaped and never matched anything real).
            if (typeof raw.conversation_id === "string" && raw.conversation_id) {
                this.sessionId = _wrapSession(raw.conversation_id);
            }
            if (this.onMessage)
                this.onMessage("", "init");
            return;
        }
        if (raw.event === "step_update") {
            const su = raw.step_update;
            if (!su || typeof su !== "object")
                return;
            // A conversation_id can also arrive here (every event carries one)
            // — keep sessionId in sync even if the init line was somehow missed.
            if (typeof su.conversation_id === "string" && su.conversation_id && !this.sessionId) {
                this.sessionId = _wrapSession(su.conversation_id);
            }
            if (su.step_type === "tool") {
                // Only emit once per tool invocation (on ACTIVE) — the DONE event
                // for the same step_index repeats tool_name with an added
                // tool_info.output, which chat-view doesn't render separately
                // (mirrors the old tool_result no-op below).
                if (su.state === "ACTIVE") {
                    const toolName = su.tool_name || "tool";
                    if (this.onMessage)
                        this.onMessage(toolName, "tool");
                }
                return;
            }
            if (su.step_type === "agent_response") {
                // text_delta is INCREMENTAL, split across an ACTIVE event (partial
                // text) and a DONE event for the SAME step_index (the trailing
                // delta, e.g. a closing "\n") — accumulate every fragment seen, in
                // order, across the whole turn. Verified byte-for-byte against the
                // terminal result.response in every live probe, including a
                // multi-step tool-use turn.
                if (typeof su.text_delta === "string" && su.text_delta) {
                    this._turnText += su.text_delta;
                    const cleaned = _scrubInternalLeaks(this._turnText);
                    if (this.onMessage)
                        this.onMessage(cleaned, "replace");
                }
                if (su.usage) {
                    this.contextTokens = su.usage.input_tokens || 0;
                }
                return;
            }
            // "user_input" (prompt echo), "unknown" (fast internal bookkeeping
            // step), "checkpoint" (periodic internal step), "system_message",
            // "finish" — none of these carry user-visible text or require
            // action; ignored by design, not by omission.
            return;
        }
        if (raw.event === "result") {
            const result = raw.result;
            if (!result || typeof result !== "object")
                return;
            this._lastResult = result;
            if (typeof result.conversation_id === "string" && result.conversation_id) {
                this.sessionId = _wrapSession(result.conversation_id);
            }
            if (result.status !== "SUCCESS") {
                // Unlike gemini-cli's separate mid-stream `error` event with a
                // severity/warning distinction, this CLI's only fatal signal is
                // a non-"SUCCESS" terminal result — verified live via an invalid
                // --model probe (status: "ERROR", non-zero exit). Reject
                // immediately (same responsiveness as the old fatal-error path)
                // so _handleClose doesn't double-fire.
                const rawMsg = typeof result.error === "string" && result.error
                    ? result.error
                    : `Antigravity CLI turn failed (status: ${result.status || "unknown"})`;
                if (this.onError)
                    this.onError(rawMsg);
                const reject = this._currentReject;
                this._currentResolve = null;
                this._currentReject = null;
                this._failed = true;
                if (reject)
                    reject(new Error(rawMsg));
                return;
            }
            if (result.usage) {
                this.contextTokens = result.usage.input_tokens || 0;
            }
            return;
        }
    }
    _handleStderr(data) {
        const text = data.toString();
        if (!text)
            return;
        this._stderrTail = (this._stderrTail + text).slice(-4096);
        const trimmed = text.trim();
        if (!trimmed)
            return;
        // Best-effort auth-missing detection. No confirmed error string is
        // available for `agy` (Antigravity docs describe silent keyring auth
        // or an OAuth flow, both opaque to us) — this regex is a defensive
        // guess at common phrasing, not a verified match. Falls through to
        // the generic failure-path message in _handleClose either way, so a
        // miss here is not silent.
        if (/not (?:authenticated|logged in)|authentication (?:required|failed)|please (?:run|sign in)|run [`'"]?agy (?:login|auth)/i.test(trimmed)) {
            if (this.onError)
                this.onError("Antigravity CLI reports it isn't authenticated. Run `agy` once in a " +
                    "terminal to complete sign-in (silent keyring auth locally, or an OAuth " +
                    "flow over SSH), then retry.");
            return;
        }
    }
    _handleClose(code) {
        this._clearWatchdog();
        this.alive = false;
        this.process = null;
        if (this._hookCleanup) {
            try {
                this._hookCleanup();
            }
            catch (e) {
                console.warn(`[gryphon/antigravity-cli] hook cleanup failed: ${e.message}`);
            }
            this._hookCleanup = null;
        }
        // If a fatal `error` JSONL event (or the watchdog) already rejected
        // the pending promise, don't emit a second close-time error.
        if (this._failed) {
            this._failed = false;
            return;
        }
        const resolve = this._currentResolve;
        const reject = this._currentReject;
        this._currentResolve = null;
        this._currentReject = null;
        if (!resolve)
            return;
        const lastResult = this._lastResult;
        if (code === 0 && lastResult && lastResult.status === "SUCCESS") {
            // Real usage field names differ from gemini-cli's `stats` shape —
            // verified: `cached` → `cache_read_tokens`; `thinking_tokens` is a
            // new field with no dedicated slot in computeCost's pricing table,
            // so it isn't separately forwarded (see header note).
            const usage = lastResult.usage || {};
            const mappedUsage = {
                promptTokenCount: usage.input_tokens || 0,
                candidatesTokenCount: usage.output_tokens || 0,
                cachedContentTokenCount: usage.cache_read_tokens || 0,
            };
            const { cost } = computeCost(mappedUsage, this.resolvedModel);
            this.lastCumulativeCost += cost;
            this.contextTokens = usage.input_tokens || 0;
            // result.response is the authoritative full text (verified
            // byte-for-byte equal to the step_update-accumulated _turnText in
            // every live probe) — prefer it, falling back to the accumulated
            // text only if the result event somehow omitted it.
            const text = typeof lastResult.response === "string" ? lastResult.response : (this._turnText || "");
            const result = {
                text,
                cost,
                cumulativeCost: this.lastCumulativeCost,
                sessionId: this.sessionId,
                duration: typeof lastResult.duration_seconds === "number"
                    ? Math.round(lastResult.duration_seconds * 1000)
                    : 0,
                contextTokens: this.contextTokens,
            };
            if (this.onDone)
                this.onDone(result);
            resolve(result);
            return;
        }
        // Failure path. code===0 with no successful lastResult (empty/partial
        // stdout, or a "result" event that never arrived) is treated as a
        // failure, never a silent empty-text success — issue #19 "never exit
        // 0 with empty stdout."
        const stderr = (this._stderrTail || "").trim();
        const resultErrorMsg = lastResult && lastResult.status !== "SUCCESS" && typeof lastResult.error === "string"
            ? lastResult.error
            : null;
        const tail = stderr
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-6)
            .join("\n");
        const header = code === 0
            ? "Antigravity CLI ended without producing a response."
            : `Antigravity CLI exited unexpectedly (exit code ${code}).`;
        const details = resultErrorMsg
            ? `\n\nDetails from Antigravity CLI:\n${resultErrorMsg}`
            : (tail ? `\n\nDetails from Antigravity CLI:\n${tail}` : "");
        const hint = "\n\nCommon causes: not signed in (run `agy` once in a terminal to " +
            "authenticate), an unpublished free-tier quota limit, or a transient " +
            "server error. Verify the CLI works by running " +
            "`agy -p 'hello' --output-format stream-json --dangerously-skip-permissions` " +
            "in a terminal.";
        reject(new Error(header + details + hint));
    }
    _handleProcessError(err) {
        this._clearWatchdog();
        this.alive = false;
        this.process = null;
        if (this._hookCleanup) {
            try {
                this._hookCleanup();
            }
            catch (_) { /* swallow — best effort */ }
            this._hookCleanup = null;
        }
        const reject = this._currentReject;
        this._currentResolve = null;
        this._currentReject = null;
        if (reject)
            reject(err);
    }
    abort() {
        this._clearWatchdog();
        if (this.process) {
            const proc = this.process;
            try {
                killProcessTree(proc, "SIGTERM");
            }
            catch { }
            setTimeoutFn(() => { try {
                killProcessTree(proc, "SIGKILL");
            }
            catch { } }, 5000);
            this.process = null;
        }
        this.alive = false;
        if (this._hookCleanup) {
            try {
                this._hookCleanup();
            }
            catch (_) { /* swallow — best effort */ }
            this._hookCleanup = null;
        }
        const reject = this._currentReject;
        this._currentResolve = null;
        this._currentReject = null;
        if (reject)
            reject(new Error("Aborted"));
    }
    isAlive() {
        return this.alive && this.process !== null;
    }
    // Cost is estimated from token counts × Google pricing tables (same
    // status as gemini-cli — Antigravity is the Gemini-based suite).
    get costIsEstimate() { return true; }
}
exports.AntigravityCliProvider = AntigravityCliProvider;
