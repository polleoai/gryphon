"use strict";
// packages/provider-runtime/src/passive/claude-passive-session.ts
// One persistent `claude` child per PassiveSession. Persistent stream-json
// transport (no --print): claude stays alive across turns and across the
// tool_use->tool_result boundary (Phase B parked-IPC needs this).
//
// Phase A (no declaredTools): text-only; each send() writes a user frame and
// resolves on the `result` event.
// Phase B (declaredTools present): claude calls the declared tools via the MCP
// shim, which PARKS each call through the bridge. The session resolves send()
// with stop_reason:"tool_use" + the tool_use blocks; the next send()'s
// tool_result blocks are routed back through the bridge to unblock the parked
// MCP calls in the same live process.
//
// See docs/superpowers/specs/2026-06-14-passive-backend-design.md §5-6, §12.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudePassiveSession = void 0;
// These run in both the Obsidian renderer and headless Node paths (CLI probes,
// passive backend, hook/IPC subprocess) where `window` is unavailable, so bind
// the ambient timer globals to module-locals. obsidianmd/prefer-window-timers
// accepts timer names that resolve to a local binding; window.* would throw in
// the headless paths.
const setTimeoutFn = setTimeout;
const clearTimeoutFn = clearTimeout;
const fs = require("fs");
const { isDeepStrictEqual } = require("node:util");
const { managedSpawn, killProcessTree } = require("../subprocess-registry");
const { buildEnhancedPath, findClaudeBinary } = require("../utils");
const { buildPassiveArgs } = require("./arg-builder");
const { PassiveStreamParser } = require("./stream-parser");
const { MCP_SERVER_NAME } = require("./mcp-config-builder");
const NS_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
function lastUserContent(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user")
            return messages[i].content;
    }
    return "";
}
// tool_result blocks from the last user message (Phase B continuation turn).
function extractToolResults(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user") {
            if (Array.isArray(m.content))
                return m.content.filter((b) => b && b.type === "tool_result");
            return [];
        }
    }
    return [];
}
function normalizeUsage(u) {
    u = u || {};
    return {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
    };
}
class ClaudePassiveSession {
    constructor(config) {
        this.config = config;
        this.claudePath = config.claudePath || findClaudeBinary() || "claude";
        this._spawnOverride = config._spawnOverride || null;
        this._mcpConfigPath = config._mcpConfigPath || null;
        this._allowedTools = config._allowedTools || null;
        this._bridge = config._bridge || null;
        this._requestTimeoutMs = typeof config.requestTimeoutMs === "number" && config.requestTimeoutMs > 0
            ? config.requestTimeoutMs : 0;
        this.process = null;
        this.sessionId = null;
        this._buffer = "";
        this._parser = null;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._turnTimer = null;
        this._stderrTail = "";
        this._closed = false;
        this._broken = null; // set when the subprocess / MCP transport dies; future send()s reject
        // Phase B per-turn + cross-turn state.
        this._pendingToolCalls = []; // {toolUseId, jsonrpcId, bareName, input} — survives the tool_use boundary
        this._resetTurn();
        if (this._bridge) {
            this._bridge.onInvoke((inv) => this._onBridgeInvoke(inv));
            this._bridge.onTransportError((err) => this._onBridgeDown(err));
        }
    }
    _resetTurn() {
        this._turnText = [];
        this._turnDeclaredToolUse = [];
        this._turnParked = [];
        this._turnUsage = null;
        this._settled = false;
    }
    _isDeclared(name) { return typeof name === "string" && name.indexOf(NS_PREFIX) === 0; }
    _bareName(name) { return this._isDeclared(name) ? name.slice(NS_PREFIX.length) : name; }
    // Drop non-declared tool_use (e.g. claude's internal ToolSearch); de-namespace declared ones.
    _sanitize(content) {
        const out = [];
        for (const b of content || []) {
            if (b && b.type === "tool_use") {
                if (!this._isDeclared(b.name))
                    continue;
                out.push({ type: "tool_use", id: b.id, name: this._bareName(b.name), input: b.input });
            }
            else {
                out.push(b);
            }
        }
        return out;
    }
    _spawn() {
        const opts = {};
        if (this._mcpConfigPath)
            opts.mcpConfigPath = this._mcpConfigPath;
        if (this._allowedTools && this._allowedTools.length > 0)
            opts.allowedTools = this._allowedTools;
        const args = buildPassiveArgs(this.config, opts);
        const spawnOpts = { cwd: this.config.cwd, env: { ...process.env, PATH: buildEnhancedPath() }, stdio: ["pipe", "pipe", "pipe"] };
        const proc = this._spawnOverride
            ? this._spawnOverride(args, spawnOpts)
            : managedSpawn(this.claudePath, args, spawnOpts, { label: "claude-passive" });
        this.process = proc;
        this._buffer = "";
        const mine = () => this.process === proc;
        proc.stdout.on("data", (d) => { if (mine())
            this._onStdout(d); });
        proc.stderr.on("data", (d) => { if (mine()) {
            this._stderrTail = (this._stderrTail + d.toString()).slice(-4096);
        } });
        proc.on("close", (code) => { if (mine())
            this._onClose(code); });
        proc.on("error", (err) => { if (mine())
            this._reject(err); });
    }
    _onStdout(data) {
        this._buffer += data.toString();
        const lines = this._buffer.split("\n");
        this._buffer = lines.pop() || "";
        for (const line of lines) {
            if (!line.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                // H2: never silently drop a stdout protocol line — a lost `result`
                // event would hang the turn. Surface it for diagnosis.
                this._malformed = (this._malformed || 0) + 1;
                console.error("[gryphon/passive] unparseable stream-json line (truncated):", line.slice(0, 200));
                continue;
            }
            this._handleEvent(parsed);
        }
    }
    _handleEvent(parsed) {
        if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
            this.sessionId = parsed.session_id;
        }
        // Phase B — track declared tool_use + text for the parked path.
        if (this._bridge && parsed.type === "assistant" && parsed.message && Array.isArray(parsed.message.content)) {
            for (const b of parsed.message.content) {
                if (b && b.type === "text" && typeof b.text === "string")
                    this._turnText.push({ type: "text", text: b.text });
                else if (b && b.type === "tool_use" && this._isDeclared(b.name))
                    this._turnDeclaredToolUse.push(b);
                // non-declared tool_use (ToolSearch) is ignored.
            }
            if (parsed.message.usage)
                this._turnUsage = parsed.message.usage;
        }
        // Feed the parser so a `result` (end_turn / error) terminates the turn.
        const done = this._parser ? this._parser.push(parsed) : null;
        if (done) {
            if (done.sessionId)
                this.sessionId = done.sessionId;
            if (done._resultError) { // C1 — error result -> reject, never fake-success
                this._reject(new Error(`claude (passive) ended with an error result: ${done._resultError}`));
                return;
            }
            delete done._resultError;
            if (this._bridge)
                done.content = this._sanitize(done.content);
            this._settle(done);
            return;
        }
        if (this._bridge)
            this._maybeSettleToolUse();
    }
    _onBridgeInvoke(inv) {
        if (!this._pendingResolve) {
            // Should not happen (claude parks within an active send). Don't drop silently.
            console.error("[gryphon/passive] bridge invoke arrived with no active send():", inv && inv.name);
            return;
        }
        this._turnParked.push(inv);
        this._maybeSettleToolUse();
    }
    // C2/H3: the MCP transport died. Mark the session broken and reject any
    // in-flight send(); a later send() rejects up front rather than respawning
    // a fresh claude that has lost all parked-IPC state and would hang.
    _onBridgeDown(err) {
        if (!this._broken)
            this._broken = err instanceof Error ? err : new Error(String(err || "passive MCP transport down"));
        if (this._pendingReject)
            this._reject(this._broken);
    }
    // Resolve the pending send() with stop_reason:"tool_use" once every declared
    // tool_use block on stdout has a correlated parked MCP call.
    _maybeSettleToolUse() {
        if (this._settled || !this._pendingResolve)
            return;
        const declared = this._turnDeclaredToolUse;
        const parked = this._turnParked;
        if (declared.length === 0 || parked.length < declared.length)
            return;
        // Correlate each parked invoke to a distinct declared tool_use by bare name
        // + input. MCP `tools/call` carries no tool_use.id, so two byte-identical
        // parallel calls (same name AND input) are paired first-fit/arbitrarily —
        // an inherent, documented ambiguity (README "Identical parallel calls").
        // Distinct inputs always correlate exactly.
        const pairs = [];
        const used = new Set();
        for (const pk of parked) {
            let idx = -1;
            for (let i = 0; i < declared.length; i++) {
                if (used.has(i))
                    continue;
                if (this._bareName(declared[i].name) === pk.name && isDeepStrictEqual(declared[i].input, pk.input)) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1)
                return; // not all correlated yet — keep waiting
            used.add(idx);
            pairs.push({ toolUseId: declared[idx].id, jsonrpcId: pk.jsonrpcId, bareName: pk.name, input: pk.input });
        }
        if (pairs.length < declared.length)
            return;
        this._pendingToolCalls = pairs;
        const content = [
            ...this._turnText,
            ...declared.map((d) => ({ type: "tool_use", id: d.id, name: this._bareName(d.name), input: d.input })),
        ];
        this._settle({
            content,
            stop_reason: "tool_use",
            usage: normalizeUsage(this._turnUsage),
            total_cost_usd: 0, // mid-turn; final cost arrives on the end_turn result of a later send()
            sessionId: this.sessionId || "",
        });
    }
    _onClose(code) {
        this.process = null;
        const tail = (this._stderrTail || "").trim();
        const err = new Error(`claude (passive) exited before producing a result (code ${code}).` + (tail ? `\n${tail}` : ""));
        if (this._pendingReject) {
            this._reject(err);
        }
        else if (this._pendingToolCalls.length > 0) {
            // C2: died in the settled-but-parked gap. Mark broken so the next send()
            // (carrying tool_results) rejects instead of respawning into a hang.
            if (!this._broken)
                this._broken = err;
        }
        this._stderrTail = "";
    }
    _clearTurnTimer() {
        if (this._turnTimer) {
            try {
                clearTimeoutFn(this._turnTimer);
            }
            catch { }
            this._turnTimer = null;
        }
    }
    _resolve(value) {
        this._clearTurnTimer();
        const r = this._pendingResolve;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._parser = null;
        if (r)
            r(value);
    }
    _settle(value) { this._settled = true; this._resolve(value); }
    _reject(err) {
        this._clearTurnTimer();
        const r = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._parser = null;
        if (r)
            r(err instanceof Error ? err : new Error(String(err)));
    }
    // Phase B: route trailing tool_result blocks back through the bridge to unblock
    // the parked MCP calls. Phase A / plain user turn: write a stdin user frame.
    _routeOrWrite(messages) {
        if (this._bridge && this._pendingToolCalls.length > 0) {
            // Continuation turn: every parked call MUST be answered, exactly once.
            const toolResults = extractToolResults(messages);
            if (toolResults.length === 0) {
                throw new Error(`passive: ${this._pendingToolCalls.length} tool call(s) are awaiting results; ` +
                    `the next send() must carry matching tool_result block(s)`);
            }
            const answered = new Set();
            for (const tr of toolResults) {
                const pc = this._pendingToolCalls.find((c) => c.toolUseId === tr.tool_use_id);
                if (!pc)
                    throw new Error(`passive: tool_result for unknown tool_use_id "${tr.tool_use_id}"`);
                const ok = this._bridge.resolve(pc.jsonrpcId, { content: tr.content, is_error: !!tr.is_error });
                if (!ok)
                    throw new Error(`passive: could not deliver tool_result for "${tr.tool_use_id}" — MCP transport is gone`);
                answered.add(pc.toolUseId);
            }
            const missing = this._pendingToolCalls.filter((c) => !answered.has(c.toolUseId));
            if (missing.length > 0) {
                throw new Error(`passive: all parked tool calls must be answered in one send() (missing ${missing.length})`);
            }
            this._pendingToolCalls = [];
            return; // claude continues from the resolved MCP calls — no new stdin frame
        }
        if (this._bridge) {
            // No calls parked: a stray tool_result is a caller mistake, not a turn.
            if (extractToolResults(messages).length > 0) {
                throw new Error("passive: received tool_result(s) but no tool calls are awaiting results");
            }
        }
        const frame = JSON.stringify({ type: "user", message: { role: "user", content: lastUserContent(messages) } });
        this.process.stdin.write(frame + "\n");
    }
    send(req) {
        const signal = req && req.signal;
        if (signal && signal.aborted)
            return Promise.reject(new Error("Aborted"));
        if (this._closed)
            return Promise.reject(new Error("session is closed"));
        if (this._broken)
            return Promise.reject(this._broken); // C2: don't respawn into a hang
        // Sequential contract: a send() must be awaited before the next.
        if (this._pendingResolve)
            return Promise.reject(new Error("a previous send() is still in flight; await it before calling send() again"));
        if (!this.process)
            this._spawn();
        if (signal && typeof signal.addEventListener === "function") {
            signal.addEventListener("abort", () => { try {
                this._abort();
            }
            catch { } }, { once: true });
        }
        this._resetTurn();
        this._parser = new PassiveStreamParser();
        if (this.sessionId)
            this._parser.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            if (this._requestTimeoutMs) {
                this._turnTimer = setTimeoutFn(() => {
                    const e = new Error(`passive: send() timed out after ${this._requestTimeoutMs}ms`);
                    this._broken = e; // a timed-out turn leaves claude in an unknown state
                    try {
                        this._abort();
                    }
                    catch {
                        this._reject(e);
                    }
                }, this._requestTimeoutMs);
                if (this._turnTimer && typeof this._turnTimer.unref === "function")
                    this._turnTimer.unref();
            }
            try {
                this._routeOrWrite(req.messages || []);
            }
            catch (e) {
                this._reject(e);
            }
        });
    }
    _abort() {
        this._pendingToolCalls = []; // M2: drop stale parked state
        if (this.process) {
            const proc = this.process;
            this.process = null;
            try {
                killProcessTree(proc, "SIGTERM");
            }
            catch { }
        }
        this._reject(new Error("Aborted"));
    }
    _cleanupConfigFile() {
        if (this._mcpConfigPath) {
            try {
                fs.rmSync(this._mcpConfigPath, { force: true });
            }
            catch { /* ignore */ }
            this._mcpConfigPath = null;
        }
    }
    async close() {
        this._closed = true;
        this._clearTurnTimer();
        if (this.process) {
            const proc = this.process;
            this.process = null;
            try {
                killProcessTree(proc, "SIGTERM");
            }
            catch { }
            const t = setTimeoutFn(() => { try {
                killProcessTree(proc, "SIGKILL");
            }
            catch { } }, 2000);
            if (t && typeof t.unref === "function")
                t.unref(); // CR-M1: don't pin the event loop
        }
        if (this._bridge) {
            try {
                await this._bridge.close();
            }
            catch { }
        }
        this._cleanupConfigFile(); // CR-H1: don't leak the temp --mcp-config file
        if (this._pendingReject)
            this._reject(new Error("session closed"));
    }
}
exports.ClaudePassiveSession = ClaudePassiveSession;
