// Gemini CLI provider — stream-json event parser unit tests.
//
// We don't actually spawn `gemini`; we construct a GeminiCliProvider
// instance, feed it synthetic stream-json via _handleStdout, and assert
// the resulting state + callback emissions.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const {
  GeminiCliProvider,
  _wrapSession,
  _unwrapSession,
  _mapPermissionToApproval,
  _scrubInternalLeaks,
  SESSION_PREFIX,
} = require("../src/providers/gemini-cli/gemini-cli");

function makeProvider(options = {}) {
  const p = new GeminiCliProvider("/bin/false", "/tmp", options);
  const captured = { messages: [], errors: [], done: null };
  p.onMessage = (text, type) => captured.messages.push({ text, type });
  p.onError = (text) => captured.errors.push(text);
  p.onDone = (result) => { captured.done = result; };
  return { provider: p, captured };
}

function feedLines(provider, lines) {
  provider._handleStdout(Buffer.from(lines.join("\n") + "\n"));
}

// ─────────────────────────────────────────────────────────────────
// Session-prefix wrap/unwrap
// ─────────────────────────────────────────────────────────────────

test("session prefix is the canonical gemini-cli marker", () => {
  assert.equal(SESSION_PREFIX, "gemini-cli-");
});

test("_wrapSession adds prefix when missing, idempotent when present", () => {
  assert.equal(_wrapSession("abc-123"), "gemini-cli-abc-123");
  assert.equal(_wrapSession("gemini-cli-already-wrapped"),
    "gemini-cli-already-wrapped");
  assert.equal(_wrapSession(null), null);
});

test("_unwrapSession strips prefix, leaves raw ids alone", () => {
  assert.equal(_unwrapSession("gemini-cli-xyz"), "xyz");
  assert.equal(_unwrapSession("xyz"), "xyz");
});

// ─────────────────────────────────────────────────────────────────
// Permission-mode mapping
// ─────────────────────────────────────────────────────────────────

test("permission-mode → approval mapping is 1-for-1 (Stage 5 — pattern enforcement at hook layer)", () => {
  assert.equal(_mapPermissionToApproval("default"), "default");
  assert.equal(_mapPermissionToApproval("acceptEdits"), "auto_edit");
  assert.equal(_mapPermissionToApproval("plan"), "plan");
  assert.equal(_mapPermissionToApproval("bypassPermissions"), "yolo");
  assert.equal(_mapPermissionToApproval(undefined), "default");
});

// ─────────────────────────────────────────────────────────────────
// Event parser — happy path
// ─────────────────────────────────────────────────────────────────

test("init event captures session_id with prefix and model", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "init",
      timestamp: "2026-05-03T00:00:00Z",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      model: "gemini-2.5-flash",
    }),
  ]);
  assert.equal(provider.sessionId, "gemini-cli-550e8400-e29b-41d4-a716-446655440000");
  assert.equal(provider.resolvedModel, "gemini-2.5-flash");
  assert.deepEqual(captured.messages, [{ text: "", type: "init" }]);
});

test("assistant message events accumulate via delta and emit replace", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "message", role: "assistant", content: "Hello", delta: true }),
    JSON.stringify({ type: "message", role: "assistant", content: " world", delta: true }),
  ]);
  assert.equal(provider._turnText, "Hello world");
  assert.deepEqual(captured.messages, [
    { text: "Hello", type: "replace" },
    { text: "Hello world", type: "replace" },
  ]);
});

test("non-delta assistant message replaces the buffer (final shape)", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "message", role: "assistant", content: "First", delta: true }),
    JSON.stringify({ type: "message", role: "assistant", content: "Final", /* no delta */ }),
  ]);
  assert.equal(provider._turnText, "Final");
  assert.equal(captured.messages.length, 2);
  assert.equal(captured.messages[1].text, "Final");
});

test("user-role messages are ignored (chat-view manages user rendering)", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "message", role: "user", content: "should be skipped" }),
  ]);
  assert.equal(captured.messages.length, 0);
  assert.equal(provider._turnText, "");
});

test("tool_use event emits the tool name as a 'tool' callback", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "tool_use",
      tool_name: "write_file",
      tool_id: "tu_1",
      parameters: { path: "/tmp/x" },
    }),
  ]);
  assert.deepEqual(captured.messages, [{ text: "write_file", type: "tool" }]);
});

test("error event surfaces via onError callback", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "error", severity: "warning", message: "model timeout" }),
  ]);
  assert.deepEqual(captured.errors, ["model timeout"]);
});

test("result event records stats as contextTokens", () => {
  const { provider } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "result",
      status: "success",
      stats: {
        total_tokens: 1500,
        input_tokens: 1000,
        output_tokens: 500,
        cached: 200,
        duration_ms: 1234,
        tool_calls: 0,
      },
    }),
  ]);
  assert.equal(provider.contextTokens, 1000);
  assert.deepEqual(provider._lastStats, {
    total_tokens: 1500, input_tokens: 1000, output_tokens: 500,
    cached: 200, duration_ms: 1234, tool_calls: 0,
  });
});

test("end-to-end happy-path event sequence resolves _handleClose with computed cost", () => {
  const { provider, captured } = makeProvider({ model: "gemini-2.5-flash" });
  let resolved = null;
  provider._currentResolve = (r) => { resolved = r; };
  provider._currentReject = () => {};
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ type: "init", session_id: "abc-1", model: "gemini-2.5-flash" }),
    JSON.stringify({ type: "message", role: "assistant", content: "OK" }),
    JSON.stringify({
      type: "result",
      status: "success",
      stats: { total_tokens: 1100, input_tokens: 1000, output_tokens: 100, cached: 0, duration_ms: 500, tool_calls: 0 },
    }),
  ]);
  provider._handleClose(0);

  assert.ok(resolved);
  assert.equal(resolved.text, "OK");
  assert.equal(resolved.sessionId, "gemini-cli-abc-1");
  assert.equal(resolved.contextTokens, 1000);
  assert.equal(resolved.duration, 500);
  // gemini-2.5-flash: 0.30/M input, 2.50/M output
  // (1000/1e6) * 0.30 + (100/1e6) * 2.50 = 0.0003 + 0.00025 = 0.00055
  assert.ok(resolved.cost > 0 && resolved.cost < 0.001, `cost=${resolved.cost}`);
  assert.equal(captured.done, resolved);
});

// ─────────────────────────────────────────────────────────────────
// Event parser — robustness
// ─────────────────────────────────────────────────────────────────

test("malformed JSON line is skipped (parser keeps going)", () => {
  const { provider, captured } = makeProvider();
  provider._handleStdout(Buffer.from(
    "not json\n" +
    JSON.stringify({ type: "message", role: "assistant", content: "Hi" }) + "\n",
  ));
  assert.equal(provider._turnText, "Hi");
  assert.deepEqual(captured.messages, [{ text: "Hi", type: "replace" }]);
});

test("non-object events are ignored", () => {
  const { provider } = makeProvider();
  feedLines(provider, [JSON.stringify(null), JSON.stringify(42)]);
  // No throw, no state change
  assert.equal(provider._turnText, "");
});

test("missing-auth stderr surfaces a clean error message", () => {
  const { provider, captured } = makeProvider();
  provider._handleStderr(Buffer.from("Please set an Auth method ..."));
  assert.equal(captured.errors.length, 1);
  assert.match(captured.errors[0], /Google API key/i);
});

// ─────────────────────────────────────────────────────────────────
// _buildArgs construction
// ─────────────────────────────────────────────────────────────────

test("_buildArgs without hooks wired uses 1-for-1 user mode mapping", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp/vault", {
    model: "gemini-2.5-pro",
    permissionMode: "default",
  });
  const args = p._buildArgs("hello");
  assert.deepEqual(args, [
    "-p", "hello",
    "-o", "stream-json",
    "--skip-trust",
    "--approval-mode", "default",
    "-m", "gemini-2.5-pro",
  ]);
});

test("_buildArgs with hooks wired forces approval-mode=yolo so the full tool palette is exposed", () => {
  // User report 2026-05-03: in headless `-p` mode with
  // approval-mode=default, Gemini hides tools that would otherwise
  // prompt for approval — model says "I have no shell tool" and
  // can't execute anything, so the BeforeTool hook never fires.
  // With hooks wired, Gryphon's classify handler is the gate, so
  // upgrading Gemini's approval-mode to yolo is safe.
  const p = new GeminiCliProvider("/bin/gemini", "/tmp/vault", {
    permissionMode: "default",
  });
  const args = p._buildArgs("hello", { hooksWired: true });
  const idx = args.indexOf("--approval-mode");
  assert.equal(args[idx + 1], "yolo");
});

test("_buildArgs with hooks wired AND plan mode keeps plan (read-only intentional)", () => {
  // Plan mode is read-only by design — preserve it even when hooks
  // are wired. The user explicitly opted into a no-side-effects
  // session; don't silently grant write access.
  const p = new GeminiCliProvider("/bin/gemini", "/tmp/vault", {
    permissionMode: "plan",
  });
  const args = p._buildArgs("hello", { hooksWired: true });
  const idx = args.indexOf("--approval-mode");
  assert.equal(args[idx + 1], "plan");
});

test("_buildArgs adds --resume with raw session_id (prefix stripped)", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp/vault", {
    resumeSessionId: "gemini-cli-abc-123",
    permissionMode: "yolo", // unmapped → default approval
  });
  const args = p._buildArgs("continue");
  const idx = args.indexOf("--resume");
  assert.ok(idx >= 0, "--resume should be present");
  assert.equal(args[idx + 1], "abc-123");
});

test("permissionMode plan maps to plan approval-mode", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
    permissionMode: "plan",
  });
  const args = p._buildArgs("test");
  const idx = args.indexOf("--approval-mode");
  assert.equal(args[idx + 1], "plan");
});

// ─────────────────────────────────────────────────────────────────
// _buildEnv — API key forwarding
// ─────────────────────────────────────────────────────────────────

test("_buildEnv forwards settings.googleApiKey as GEMINI_API_KEY", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
    plugin: { settings: { googleApiKey: "AIza-test-key-value" } },
  });
  const env = p._buildEnv();
  assert.equal(env.GEMINI_API_KEY, "AIza-test-key-value");
});

test("_buildEnv preserves existing env when settings key is empty", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
    plugin: { settings: { googleApiKey: "" } },
  });
  // Snapshot what was in env before; _buildEnv shouldn't blow it away.
  const env = p._buildEnv();
  assert.equal(typeof env.PATH, "string");
});

test("V13-1: _buildEnv falls back to GOOGLE_API_KEY env when settings is empty", () => {
  // Symmetric with the factory's googleKey resolution: if the user has
  // GOOGLE_API_KEY exported but no settings entry, the spawn must still
  // get GEMINI_API_KEY in its env. Before this fix the user would pass
  // the factory's availability gate but fail at spawn.
  const orig = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "AIza-from-env";
  try {
    const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
      plugin: { settings: { googleApiKey: "" } },
    });
    const env = p._buildEnv();
    assert.equal(env.GEMINI_API_KEY, "AIza-from-env");
  } finally {
    if (orig === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = orig;
  }
});

test("V13-1: settings key takes precedence over env when both present", () => {
  const orig = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "AIza-env-key";
  try {
    const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
      plugin: { settings: { googleApiKey: "AIza-settings-key" } },
    });
    const env = p._buildEnv();
    assert.equal(env.GEMINI_API_KEY, "AIza-settings-key",
      "settings wins — keeps the 'paste a key in Settings' UX intact");
  } finally {
    if (orig === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = orig;
  }
});

test("V13-2: fatal error event rejects the pending promise once (no double-error on close)", () => {
  const { provider } = makeProvider();
  let resolved = null;
  let rejected = null;
  provider._currentResolve = (r) => { resolved = r; };
  provider._currentReject = (e) => { rejected = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ type: "error", severity: "error", message: "fatal: API quota exceeded" }),
  ]);
  assert.ok(rejected, "error event rejects the promise");
  assert.match(rejected.message, /quota/);
  assert.equal(resolved, null);

  // The CLI now closes (typically non-zero exit). _handleClose must NOT
  // emit a second reject — V13-2.
  let secondReject = null;
  provider._currentResolve = null;
  provider._currentReject = (e) => { secondReject = e; };
  provider._handleClose(1);
  assert.equal(secondReject, null, "close-time reject is suppressed");
});

test("V13-2: warning-severity error event does NOT reject (CLI handles retries internally)", () => {
  const { provider, captured } = makeProvider();
  let rejected = null;
  provider._currentResolve = () => {};
  provider._currentReject = (e) => { rejected = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ type: "error", severity: "warning", message: "transient: retrying" }),
  ]);
  assert.equal(rejected, null, "warnings surface via onError but don't kill the turn");
  assert.equal(captured.errors.length, 1);
});

// ─────────────────────────────────────────────────────────────────
// _scrubInternalLeaks — keep "BeforeTool" / "hook" wording out of
// the user-visible chat output (Stage 5 — same shape as Codex).
// ─────────────────────────────────────────────────────────────────

test("_scrubInternalLeaks strips 'Command blocked by BeforeTool hook:' prefix", () => {
  const input =
    "Command blocked by BeforeTool hook: This operation matches a protected pattern in Gryphon.\n\n" +
    "To allow it: open Settings.";
  const out = _scrubInternalLeaks(input);
  assert.ok(!out.includes("BeforeTool hook"));
  assert.match(out, /matches a protected pattern/);
});

test("_scrubInternalLeaks strips '(via a hook)' parentheticals", () => {
  for (const phrase of [
    "Blocked (via a hook).",
    "Refused (by the hook).",
  ]) {
    const out = _scrubInternalLeaks(phrase);
    assert.ok(!/hook/i.test(out), `hook leaked from: ${phrase} → ${out}`);
  }
});

test("_scrubInternalLeaks strips trailing 'Command: <echoed shell>' segment", () => {
  const input =
    "This matches a protected pattern in Gryphon.\n\n" +
    "Ask me again. Command: rm /tmp/x";
  const out = _scrubInternalLeaks(input);
  assert.ok(!/Command:\s+rm/.test(out));
  assert.match(out, /Ask me again/);
});

test("V13H-3 (Round 2): code-fenced 'Command:' line does NOT eat closing fence + trailing prose", () => {
  const input =
    "Here is the example:\n" +
    "```\n" +
    "ls -la\n" +
    "Command: ls\n" +
    "```\n" +
    "\n" +
    "That's how it works.";
  const out = _scrubInternalLeaks(input);
  assert.ok(out.includes("```\nls -la"), "fence preserved");
  assert.ok(out.includes("That's how it works."), "trailing prose preserved");
  assert.ok(out.includes("Command: ls"), "fenced 'Command:' content preserved");
});

test("end-to-end: assistant message is scrubbed before being passed to onMessage", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Command blocked by BeforeTool hook: This operation matches one of your protected patterns in Gryphon.",
    }),
  ]);
  const msg = captured.messages.find((m) => m.type === "replace");
  assert.ok(msg);
  assert.ok(!msg.text.includes("BeforeTool hook"));
  assert.match(msg.text, /matches one of your protected patterns/);
});

// ─────────────────────────────────────────────────────────────────
// QA1-2 / QA1-3 — foreign-prefix detection
// ─────────────────────────────────────────────────────────────────

test("QA1-2: _wrapSession returns null for foreign-prefixed ids", () => {
  // codex-cli session shouldn't be treated as resumable by gemini-cli.
  assert.equal(_wrapSession("codex-cli-uuid"), null);
  assert.equal(_wrapSession("sdk-12345"), null);
  assert.equal(_wrapSession("openai-sdk-12345"), null);
  assert.equal(_wrapSession("gemini-sdk-12345"), null);
  // Own prefix and raw uuids both work.
  assert.equal(_wrapSession("gemini-cli-x"), "gemini-cli-x");
  assert.equal(_wrapSession("550e8400-e29b-41d4-a716-446655440000"),
    "gemini-cli-550e8400-e29b-41d4-a716-446655440000");
});

test("QA1-2: constructor with foreign resumeSessionId starts fresh (no --resume in argv)", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp", {
    resumeSessionId: "codex-cli-foreign-id",
  });
  assert.equal(p.sessionId, null);
  const args = p._buildArgs("hello");
  assert.equal(args.indexOf("--resume"), -1,
    "foreign id must NOT trigger --resume flag");
});

// ─────────────────────────────────────────────────────────────────
// QA1-1 — _failed flag reset
// ─────────────────────────────────────────────────────────────────

test("QA1-1: integration — fatal error then new turn → second turn resolves normally", () => {
  const { provider } = makeProvider({ model: "gemini-2.5-flash" });
  let firstReject = null;
  provider._currentResolve = () => {};
  provider._currentReject = (e) => { firstReject = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  // Turn 1: fatal error sets _failed=true.
  feedLines(provider, [
    JSON.stringify({ type: "error", severity: "error", message: "first turn fatal" }),
  ]);
  assert.ok(firstReject);
  assert.equal(provider._failed, true);

  // Simulate the per-turn reset block from send() (mirrors the source).
  provider._buffer = "";
  provider._stderrTail = "";
  provider._turnText = "";
  provider._lastStats = null;
  provider._failed = false;

  // Turn 2: normal completion must NOT be silently dropped.
  let secondResolve = null;
  provider._currentResolve = (r) => { secondResolve = r; };
  provider._currentReject = () => {};
  feedLines(provider, [
    JSON.stringify({ type: "init", session_id: "abc-2", model: "gemini-2.5-flash" }),
    JSON.stringify({ type: "message", role: "assistant", content: "OK" }),
    JSON.stringify({
      type: "result",
      stats: { input_tokens: 10, output_tokens: 1, cached: 0, duration_ms: 1, tool_calls: 0 },
    }),
  ]);
  provider._handleClose(0);
  assert.ok(secondResolve, "turn 2 must resolve — _failed reset cleared the suppress flag");
  assert.equal(secondResolve.text, "OK");
});

// ─────────────────────────────────────────────────────────────────
// costIsEstimate
// ─────────────────────────────────────────────────────────────────

test("costIsEstimate is true (cost computed from token counts × pricing)", () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp");
  assert.equal(p.costIsEstimate, true);
});
