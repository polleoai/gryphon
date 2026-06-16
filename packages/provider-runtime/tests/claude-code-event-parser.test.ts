/**
 * claude-code functional suite — parity with codex/gemini event-parser tests.
 *
 * The claude-code provider is the most complex CLI provider (persistent
 * process, stream-json I/O, stale-session recovery, supersede, hook settings)
 * yet previously had only structured-output + budget coverage. This drives the
 * logic-heavy surface directly through the instance: _processEvent (every event
 * type), _handleStdout buffering, _handleStderr stale-session detection +
 * tail, _handleStaleSession recovery, abort() tree-kill, _handleClose error
 * formatting, and _redactStderrForDisplay.
 *
 * Methods are exercised by constructing a provider (options-bag form, no real
 * spawn) and calling them directly with crafted events / wiring the callbacks —
 * the same approach the parser is built around (state + onMessage/onDone).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");

// Construct without spawning. The bag form { config, hostAdapter, _spawnOverride }
// sets options.model + hostAdapter; claudePath/cwd default to "".
function makeProvider(opts = {}) {
  const p = new ClaudeCodeProvider({ config: { model: "claude-opus-4-8" }, hostAdapter: opts.hostAdapter });
  if (opts.cwd) p.cwd = opts.cwd;
  const messages = [];
  const errors = [];
  let done = null;
  p.onMessage = (text, type) => messages.push({ text, type });
  p.onError = (e) => errors.push(e);
  p.onDone = (r) => { done = r; };
  return { p, messages, errors, getDone: () => done };
}

// ── _processEvent: system/init ───────────────────────────────────────────────
test("system/init captures session_id + resolved model and emits init", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8" });
  assert.equal(p.sessionId, "sess-1");
  assert.equal(p.resolvedModel, "claude-opus-4-8");
  assert.deepEqual(messages[0], { text: "", type: "init" });
});

// ── _processEvent: stream_event deltas ───────────────────────────────────────
test("stream_event text_delta accumulates turnText and emits replace", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
  p._processEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
  assert.equal(p.turnText, "Hello");
  assert.equal(messages.at(-1).type, "replace");
  assert.equal(messages.at(-1).text, "Hello");
});

test("stream_event thinking_delta accumulates per-index (Issue #4)", () => {
  const { p } = makeProvider();
  p._processEvent({ type: "stream_event", event: { index: 0, type: "content_block_delta", delta: { type: "thinking_delta", thinking: "step " } } });
  p._processEvent({ type: "stream_event", event: { index: 0, type: "content_block_delta", delta: { type: "thinking_delta", thinking: "one" } } });
  assert.equal(p._thinkingByIndex[0], "step one");
});

test("content_block_start inserts a paragraph break before a new text block", () => {
  const { p } = makeProvider();
  p.turnText = "first answer";
  p._processEvent({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  assert.ok(p.turnText.endsWith("\n\n"), "padding inserted so blocks don't run together");
});

// ── _processEvent: assistant ─────────────────────────────────────────────────
test("assistant text sets turnText when empty", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } });
  assert.equal(p.turnText, "hi there");
  assert.equal(messages.at(-1).type, "replace");
});

test("assistant text appends a NEW block (deny copy after a streamed summary) — user report 2026-05-03", () => {
  const { p } = makeProvider();
  p.turnText = "summary text";
  p._processEvent({ type: "assistant", message: { content: [{ type: "text", text: "This operation was blocked." }] } });
  assert.ok(p.turnText.includes("summary text"));
  assert.ok(p.turnText.includes("This operation was blocked."));
});

test("assistant text already present is NOT duplicated", () => {
  const { p } = makeProvider();
  p.turnText = "already streamed";
  p._processEvent({ type: "assistant", message: { content: [{ type: "text", text: "already streamed" }] } });
  assert.equal(p.turnText, "already streamed");
});

test("assistant tool_use emits a 'tool' callback with the tool name", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
  assert.deepEqual(messages.at(-1), { text: "Bash", type: "tool" });
});

test("assistant thinking + redacted_thinking are captured into turnThinking", () => {
  const { p } = makeProvider();
  p._processEvent({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "reasoning..." },
    { type: "redacted_thinking" },
  ] } });
  assert.deepEqual(p.turnThinking, ["reasoning...", "[redacted thinking]"]);
});

test("assistant usage → contextTokens counts input + cache, NOT output tokens", () => {
  const { p } = makeProvider();
  p._processEvent({ type: "assistant", message: { content: [], usage: {
    input_tokens: 100, output_tokens: 999, cache_creation_input_tokens: 20, cache_read_input_tokens: 5,
  } } });
  assert.equal(p.contextTokens, 125); // 100 + 20 + 5; output excluded
});

// ── _processEvent: top-level tool_use + tool_result ──────────────────────────
test("top-level tool_use emits a 'tool' callback", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "tool_use", name: "Write" });
  assert.deepEqual(messages.at(-1), { text: "Write", type: "tool" });
});

test("tool_result event is a no-op (no callback, no throw)", () => {
  const { p, messages } = makeProvider();
  p._processEvent({ type: "tool_result", content: "x" });
  assert.equal(messages.length, 0);
});

// ── _processEvent: result ────────────────────────────────────────────────────
test("result computes per-turn cost delta, resolves the turn, and resets state", () => {
  const { p, getDone } = makeProvider();
  let resolved = null;
  p.pendingResolve = (r) => { resolved = r; };
  p.pendingReject = () => {};
  p.lastCumulativeCost = 0.01;
  p.turnText = "the answer";
  p.contextTokens = 42;
  p._processEvent({ type: "result", total_cost_usd: 0.03, session_id: "sess-9", duration_ms: 1234 });
  assert.equal(resolved.text, "the answer");
  assert.ok(Math.abs(resolved.cost - 0.02) < 1e-9, "0.03 cumulative − 0.01 prior ≈ 0.02 this turn (float-tolerant)");
  assert.equal(resolved.cumulativeCost, 0.03);
  assert.equal(resolved.sessionId, "sess-9");
  assert.equal(resolved.duration, 1234);
  assert.equal(resolved.contextTokens, 42);
  assert.equal(p.lastCumulativeCost, 0.03);
  assert.equal(p.turnText, "", "turn state reset for the next turn");
  assert.equal(getDone().text, "the answer");
});

test("result prefers accumulated turnText over raw.result, falls back when empty", () => {
  const { p } = makeProvider();
  p.pendingResolve = () => {}; p.pendingReject = () => {};
  // empty turnText → fall back to raw.result
  let r1 = null; p.pendingResolve = (r) => { r1 = r; };
  p._processEvent({ type: "result", result: "fallback text", total_cost_usd: 0 });
  assert.equal(r1.text, "fallback text");
});

test("result flushes streamed thinking deltas into the result", () => {
  const { p } = makeProvider();
  let r = null; p.pendingResolve = (x) => { r = x; }; p.pendingReject = () => {};
  p._thinkingByIndex = { 1: "second", 0: "first" };
  p.turnText = "answer";
  p._processEvent({ type: "result", total_cost_usd: 0 });
  assert.deepEqual(r.thinking, ["first", "second"], "ordered by block index");
});

// ── _handleStdout buffering ──────────────────────────────────────────────────
test("_handleStdout keeps a partial trailing line in the buffer until newline", () => {
  const { p } = makeProvider();
  p._handleStdout(Buffer.from('{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"ass'));
  assert.equal(p.sessionId, "s1");
  assert.ok(p.buffer.startsWith('{"type":"ass'), "incomplete line retained");
});

test("_handleStdout skips a malformed JSON line without throwing", () => {
  const { p } = makeProvider();
  assert.doesNotThrow(() => p._handleStdout(Buffer.from("not json at all\n")));
});

test("_handleStdout processes multiple complete events in one chunk", () => {
  const { p, messages } = makeProvider();
  p._handleStdout(Buffer.from(
    '{"type":"system","subtype":"init","session_id":"s2","model":"claude-opus-4-8"}\n' +
    '{"type":"assistant","message":{"content":[{"type":"text","text":"yo"}]}}\n',
  ));
  assert.equal(p.sessionId, "s2");
  assert.equal(p.turnText, "yo");
});

// ── _handleStderr ────────────────────────────────────────────────────────────
test("_handleStderr detects the stale-session sentence and triggers recovery", () => {
  const { p } = makeProvider();
  let recovered = false;
  p._handleStaleSession = () => { recovered = true; };
  p._handleStderr(Buffer.from("No conversation found with session ID: abc\n"));
  assert.equal(recovered, true);
});

test("_handleStderr accumulates a 4KB tail and surfaces normal text via onError", () => {
  const { p, errors } = makeProvider();
  p._handleStderr(Buffer.from("some warning line\n"));
  assert.ok(p._stderrTail.includes("some warning line"));
  assert.deepEqual(errors, ["some warning line"]);
  p._handleStderr(Buffer.from("x".repeat(5000)));
  assert.ok(p._stderrTail.length <= 4096, "tail is capped at 4KB");
});

// ── _handleStaleSession recovery ─────────────────────────────────────────────
test("_handleStaleSession fires once, drops the stale resume, and notifies the host", () => {
  const { p } = makeProvider();
  p.spawn = () => {};                 // isolate from the real spawn/arg path
  p.process = null; p.alive = true;
  p.options.resumeSessionId = "11111111-1111-1111-1111-111111111111";
  p.sessionId = "old";
  let expired = 0;
  p.onSessionExpired = () => { expired++; };
  p._lastPrompt = "redo this";
  p._writePrompt = () => {};          // stub the re-send
  p._handleStaleSession();
  assert.equal(p._staleRecoveryFired, true);
  assert.equal(p.options.resumeSessionId, undefined, "stale resume dropped so respawn is fresh");
  assert.equal(p.sessionId, null);
  assert.equal(expired, 1, "host asked to wipe its persisted lastSessionId");
  // second invocation is a no-op (guarded)
  p.onSessionExpired = () => { expired++; };
  p._handleStaleSession();
  assert.equal(expired, 1, "recovery does not loop");
});

// ── abort() ──────────────────────────────────────────────────────────────────
test("abort() ends stdin, tree-kills, clears state, and rejects the pending turn", () => {
  const { p } = makeProvider();
  const child = new EventEmitter();
  child.pid = 4242; child.exitCode = null; child.signalCode = null;
  let stdinEnded = false, killed = false;
  child.stdin = { end: () => { stdinEnded = true; } };
  child.kill = () => { killed = true; return true; };
  p.process = child; p.alive = true;
  let rejected = null;
  p.pendingReject = (e) => { rejected = e; };
  p.abort();
  assert.equal(stdinEnded, true);
  assert.equal(killed, true, "killProcessTree falls back to child.kill for the fake pgid");
  assert.equal(p.process, null);
  assert.equal(p.alive, false);
  assert.match(rejected.message, /Aborted/);
});

// ── _handleClose + _formatCloseError ─────────────────────────────────────────
test("_handleClose rejects the pending turn with a formatted close error", () => {
  const { p } = makeProvider();
  let rejected = null;
  p.pendingReject = (e) => { rejected = e; };
  p._stderrTail = "Error: unknown model 'bogus'";
  p._handleClose(1);
  assert.match(rejected.message, /exited unexpectedly \(exit code 1\)/);
  assert.match(rejected.message, /unknown model/);
  assert.equal(p.alive, false);
});

test("_formatCloseError distinguishes clean exit (code 0) from a crash", () => {
  const { p } = makeProvider();
  assert.match(p._formatCloseError(0), /ended without producing a response/);
  assert.match(p._formatCloseError(2), /exited unexpectedly \(exit code 2\)/);
});

// ── _redactStderrForDisplay ──────────────────────────────────────────────────
test("_redactStderrForDisplay scrubs home dir, vault path, and API-key fragments", () => {
  const { p } = makeProvider({ cwd: "/Users/tester/MyVault" });
  const os = require("node:os");
  const home = os.homedir();
  const input = `failed at ${home}/x and /Users/tester/MyVault/note.md key sk-ant-ABCDEFGH12345`;
  const out = p._redactStderrForDisplay(input);
  assert.ok(!out.includes("/Users/tester/MyVault"), "vault path redacted to <vault>");
  assert.ok(out.includes("<vault>"));
  assert.ok(out.includes("sk-ant-***REDACTED***"), "key fragment redacted");
  if (home && home.length >= 3) assert.ok(!out.includes(home), "home dir redacted to ~");
});

test("_redactStderrForDisplay passes non-string input through untouched", () => {
  const { p } = makeProvider();
  assert.equal(p._redactStderrForDisplay(null), null);
});

// ── cost authority ───────────────────────────────────────────────────────────
test("costIsEstimate is false (Claude Code reports authoritative server-side cost)", () => {
  const { p } = makeProvider();
  assert.equal(p.costIsEstimate, false);
});
