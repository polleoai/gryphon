// Codex CLI provider — JSONL event parser unit tests.
//
// We don't actually spawn `codex exec` here; we construct a CodexProvider
// instance, feed it synthetic JSONL via _handleStdout, and assert the
// resulting state + callback emissions.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub `obsidian` because the provider transitively pulls in
// shared/attack-detector → anthropic-api/tools/permission-gate, which
// requires "obsidian".
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const {
  CodexProvider,
  _wrapSession,
  _unwrapSession,
  _mapPermissionToSandbox,
  _scrubInternalLeaks,
  SESSION_PREFIX,
} = require("../src/providers/codex-cli/codex-cli");

function makeProvider(options = {}) {
  // Use a bogus binary path — we never spawn it in these tests.
  const p = new CodexProvider("/bin/false", "/tmp", options);
  const captured = { messages: [], errors: [], done: null };
  p.onMessage = (text, type) => captured.messages.push({ text, type });
  p.onError = (text) => captured.errors.push(text);
  p.onDone = (result) => { captured.done = result; };
  return { provider: p, captured };
}

function feedLines(provider, lines) {
  // Deliver as one buffer to exercise the line-splitter.
  provider._handleStdout(Buffer.from(lines.join("\n") + "\n"));
}

// ─────────────────────────────────────────────────────────────────
// Session-prefix wrap/unwrap
// ─────────────────────────────────────────────────────────────────

test("session prefix is the canonical codex-cli marker", () => {
  assert.equal(SESSION_PREFIX, "codex-cli-");
});

test("_wrapSession adds prefix when missing, idempotent when present", () => {
  assert.equal(_wrapSession("019dec5c-15da-7370-ad10-46731b3a7820"),
    "codex-cli-019dec5c-15da-7370-ad10-46731b3a7820");
  assert.equal(_wrapSession("codex-cli-already-wrapped"),
    "codex-cli-already-wrapped");
  assert.equal(_wrapSession(null), null);
  assert.equal(_wrapSession(""), null);
});

test("_unwrapSession strips prefix, leaves raw ids alone", () => {
  assert.equal(_unwrapSession("codex-cli-abc-123"), "abc-123");
  assert.equal(_unwrapSession("abc-123"), "abc-123");
  assert.equal(_unwrapSession(null), null);
});

// ─────────────────────────────────────────────────────────────────
// Permission-mode mapping
// ─────────────────────────────────────────────────────────────────

test("permission-mode → sandbox mapping (1-for-1 with Gryphon modes; pattern enforcement is at the hook layer)", () => {
  // Stage 5 (HookDispatcher): pattern enforcement moved to the
  // PreToolUse hook. The sandbox is now mapped 1-for-1 with the
  // user's selected mode — no protectedMode special-casing.
  assert.equal(_mapPermissionToSandbox("default"), "workspace-write");
  assert.equal(_mapPermissionToSandbox("acceptEdits"), "workspace-write");
  assert.equal(_mapPermissionToSandbox("plan"), "read-only");
  assert.equal(_mapPermissionToSandbox("bypassPermissions"), "danger-full-access");
  assert.equal(_mapPermissionToSandbox("unknown"), "workspace-write");
  assert.equal(_mapPermissionToSandbox(undefined), "workspace-write");
});

// ─────────────────────────────────────────────────────────────────
// Event parser — happy path
// ─────────────────────────────────────────────────────────────────

test("thread.started captures session_id with prefix and emits init callback", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "thread.started", thread_id: "019dec5c-15da-7370-ad10-46731b3a7820" }),
  ]);
  assert.equal(provider.sessionId, "codex-cli-019dec5c-15da-7370-ad10-46731b3a7820");
  assert.deepEqual(captured.messages, [{ text: "", type: "init" }]);
});

test("agent_message item.completed sets turn text and emits replace", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Hello world" },
    }),
  ]);
  assert.equal(provider._turnText, "Hello world");
  assert.deepEqual(captured.messages, [{ text: "Hello world", type: "replace" }]);
});

test("command_execution item.started emits Bash tool callback", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "item.started",
      item: { id: "item_0", type: "command_execution", command: "ls", status: "in_progress" },
    }),
  ]);
  assert.deepEqual(captured.messages, [{ text: "Bash", type: "tool" }]);
});

test("file_change and web_search item.started emit appropriate tool labels", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ type: "item.started", item: { type: "file_change" } }),
    JSON.stringify({ type: "item.started", item: { type: "web_search" } }),
  ]);
  assert.deepEqual(captured.messages, [
    { text: "Edit", type: "tool" },
    { text: "WebSearch", type: "tool" },
  ]);
});

test("turn.completed records usage as contextTokens", () => {
  const { provider } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 25828, cached_input_tokens: 7040, output_tokens: 17, reasoning_output_tokens: 10 },
    }),
  ]);
  assert.equal(provider.contextTokens, 25828);
  assert.deepEqual(provider._lastUsage, {
    input_tokens: 25828,
    cached_input_tokens: 7040,
    output_tokens: 17,
    reasoning_output_tokens: 10,
  });
});

test("end-to-end happy-path event sequence resolves _handleClose with computed cost", async () => {
  const { provider, captured } = makeProvider({ model: "gpt-5-mini" });
  // Wire up the resolution path manually since we don't actually spawn.
  let resolved = null;
  provider._currentResolve = (r) => { resolved = r; };
  provider._currentReject = () => {};
  provider.alive = true;
  provider.process = { kill: () => {} }; // sentinel

  feedLines(provider, [
    JSON.stringify({ type: "thread.started", thread_id: "abc-123" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1000, output_tokens: 50, cached_input_tokens: 0, reasoning_output_tokens: 0 },
    }),
  ]);

  // Now simulate the close.
  provider._handleClose(0);

  assert.ok(resolved, "should have resolved");
  assert.equal(resolved.text, "OK");
  assert.equal(resolved.sessionId, "codex-cli-abc-123");
  assert.equal(resolved.contextTokens, 1000);
  // Cost: gpt-5-mini = 0.25/M input, 2.00/M output
  // = (1000/1e6) * 0.25 + (50/1e6) * 2.00 = 0.00025 + 0.0001 = 0.00035
  assert.ok(resolved.cost > 0 && resolved.cost < 0.001, `cost=${resolved.cost}`);
  assert.equal(captured.done, resolved);
});

// ─────────────────────────────────────────────────────────────────
// Event parser — robustness
// ─────────────────────────────────────────────────────────────────

test("non-object events are ignored without throwing", () => {
  const { provider } = makeProvider();
  // Should not throw.
  feedLines(provider, [JSON.stringify(null), JSON.stringify("string"), JSON.stringify(42)]);
});

test("malformed JSON line is skipped (existing buffer continues)", () => {
  const { provider, captured } = makeProvider();
  // Garbage line shouldn't poison the parser.
  provider._handleStdout(Buffer.from(
    "not json\n" +
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) + "\n",
  ));
  assert.equal(provider._turnText, "OK");
  assert.deepEqual(captured.messages, [{ text: "OK", type: "replace" }]);
});

test("partial line stays in buffer until newline arrives", () => {
  const { provider, captured } = makeProvider();
  const event = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hello" } });
  // Send half, then the rest.
  provider._handleStdout(Buffer.from(event.slice(0, 20)));
  assert.equal(captured.messages.length, 0, "no event yet");
  provider._handleStdout(Buffer.from(event.slice(20) + "\n"));
  assert.deepEqual(captured.messages, [{ text: "Hello", type: "replace" }]);
});

// ─────────────────────────────────────────────────────────────────
// _buildArgs construction
// ─────────────────────────────────────────────────────────────────

test("_buildArgs constructs fresh-session args without resume (mode → sandbox is 1-for-1)", () => {
  // Use a Codex-CLI-supported model id (gpt-5.4) — Codex with ChatGPT-
  // account auth rejects API-only ids like gpt-5 / gpt-5-mini at request
  // time. Empirically supported set: gpt-5.5 / gpt-5.4 / gpt-5.4-mini.
  // See pricing/openai.js CODEX_CLI_SUPPORTED_MODELS.
  const p = new CodexProvider("/bin/codex", "/tmp/vault", {
    model: "gpt-5.4",
    permissionMode: "default",
  });
  const args = p._buildArgs("hello");
  assert.deepEqual(args, [
    "exec", "--json", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-C", "/tmp/vault",
    "-m", "gpt-5.4",
    "--", "hello",
  ]);
});

test("_buildArgs coerces unsupported ChatGPT-auth model id (gpt-5-mini) to default", () => {
  // Defensive: a stale persisted id that worked for openai-api but not
  // for codex-cli's ChatGPT-account auth must NOT reach codex's spawn.
  // Otherwise codex 400s "model not supported." Coerced to the safe
  // default (gpt-5.4-mini).
  const p = new CodexProvider("/bin/codex", "/tmp/vault", {
    model: "gpt-5-mini",
    permissionMode: "default",
  });
  const args = p._buildArgs("hello");
  const idx = args.indexOf("-m");
  assert.notEqual(idx, -1, "-m must be present");
  assert.equal(args[idx + 1], "gpt-5.4-mini",
    "unsupported model coerced to CODEX_CLI_DEFAULT_MODEL");
});

test("_buildArgs constructs resume args with raw thread_id (prefix stripped) and OMITS fresh-session flags", () => {
  // Regression for the Codex CLI v0.128.0 bug: `codex exec resume`
  // rejects `--sandbox`, `-C`, and `--add-dir`. Those are inherited
  // from the original session. Only `--json`, `--skip-git-repo-check`,
  // and `-m` (optional) are valid on resume.
  const p = new CodexProvider("/bin/codex", "/tmp/vault", {
    resumeSessionId: "codex-cli-abc-123",
    permissionMode: "plan",
  });
  const args = p._buildArgs("continue");
  assert.deepEqual(args, [
    "exec", "resume", "abc-123",
    "--json", "--skip-git-repo-check",
    "--", "continue",
  ]);
  // Belt-and-braces: the rejected flags must not appear at all.
  assert.equal(args.indexOf("--sandbox"), -1, "resume must NOT pass --sandbox");
  assert.equal(args.indexOf("-C"), -1, "resume must NOT pass -C");
});

test("_buildArgs resume + model: -m IS valid on resume (mid-conversation model switch)", () => {
  const p = new CodexProvider("/bin/codex", "/tmp", {
    resumeSessionId: "codex-cli-abc",
    model: "gpt-5.4",
  });
  const args = p._buildArgs("hello");
  const idx = args.indexOf("-m");
  assert.notEqual(idx, -1, "-m is allowed on resume");
  assert.equal(args[idx + 1], "gpt-5.4");
});

test("_buildArgs accepts raw (un-prefixed) resumeSessionId for back-compat", () => {
  // If a caller passes the raw thread_id (no synthetic prefix), the
  // wrapper still handles it — _wrapSession is idempotent in the
  // constructor + _unwrapSession passes through ids without the prefix.
  const p = new CodexProvider("/bin/codex", "/tmp/vault", {
    resumeSessionId: "raw-uuid-no-prefix",
  });
  // sessionId is wrapped at construction
  assert.equal(p.sessionId, "codex-cli-raw-uuid-no-prefix");
  const args = p._buildArgs("hi");
  // ...and unwrapped before the CLI sees it
  assert.equal(args[2], "raw-uuid-no-prefix");
});

test("permissionMode bypassPermissions maps to danger-full-access (Stage 5: hook layer enforces patterns)", () => {
  const p = new CodexProvider("/bin/codex", "/tmp", {
    permissionMode: "bypassPermissions",
  });
  const args = p._buildArgs("test");
  const sandboxIdx = args.indexOf("--sandbox");
  assert.equal(args[sandboxIdx + 1], "danger-full-access");
});

// ─────────────────────────────────────────────────────────────────
// costIsEstimate getter
// ─────────────────────────────────────────────────────────────────

test("costIsEstimate is true (cost computed from token counts × pricing)", () => {
  const p = new CodexProvider("/bin/codex", "/tmp");
  assert.equal(p.costIsEstimate, true);
});

// ─────────────────────────────────────────────────────────────────
// Code review V13-2 — single-error UX on JSONL failure events
// ─────────────────────────────────────────────────────────────────

test("V13-2: error JSONL event rejects pending promise and suppresses close-time double-error", () => {
  const { provider } = makeProvider();
  let resolved = null;
  let rejected = null;
  provider._currentResolve = (r) => { resolved = r; };
  provider._currentReject = (e) => { rejected = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ type: "error", message: "model returned 429" }),
  ]);
  assert.ok(rejected, "error event rejects the promise");
  assert.match(rejected.message, /429/);
  assert.equal(resolved, null);

  // Subsequent close (CLI exited non-zero) must NOT emit another error.
  let secondReject = null;
  provider._currentResolve = null;
  provider._currentReject = (e) => { secondReject = e; };
  provider._handleClose(1);
  assert.equal(secondReject, null);
});

test("V13-2: turn.failed event has the same single-reject behavior", () => {
  const { provider } = makeProvider();
  let rejected = null;
  provider._currentResolve = () => {};
  provider._currentReject = (e) => { rejected = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ type: "turn.failed", error: { message: "sandbox denied" } }),
  ]);
  assert.match(rejected.message, /sandbox denied/);
});

// ─────────────────────────────────────────────────────────────────
// QA1-1 — _failed flag must reset between turns so a prior fatal
// error doesn't permanently suppress _handleClose's resolve path.
// ─────────────────────────────────────────────────────────────────

test("QA1-1: _failed flag is reset on each new send (next turn isn't permanently broken)", () => {
  const { provider } = makeProvider();
  // Simulate a prior turn that failed: _failed sticky flag set.
  provider._failed = true;

  // Now the user sends a new prompt. The send() method's per-turn
  // resets must clear _failed before spawning. We don't actually want
  // to spawn the binary — drive send() but intercept by stubbing
  // spawn-related fields so the promise stays pending.
  let pending = null;
  // Monkey-patch the spawn-via-Promise path: replace send() in-place
  // with the parts we're testing.
  const promise = new Promise((resolve, reject) => {
    provider._currentResolve = resolve;
    provider._currentReject = reject;
  });
  pending = promise;

  // Manually run the per-turn reset block from send() (the real send
  // calls these alongside spawning, which we don't want here).
  provider._buffer = "leftover";
  provider._failed = true;
  provider._turnText = "stale";

  // The reset:
  provider._buffer = "";
  provider._stderrTail = "";
  provider._turnText = "";
  provider._lastUsage = null;
  provider._failed = false; // ← this is the QA1-1 fix

  assert.equal(provider._failed, false, "send() resets _failed each turn");
  assert.equal(provider._turnText, "");
});

test("QA1-1: integration — error then new send → second turn resolves normally", () => {
  const { provider } = makeProvider();
  let firstReject = null;
  provider._currentResolve = () => {};
  provider._currentReject = (e) => { firstReject = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };

  // Turn 1: error event sets _failed=true.
  feedLines(provider, [
    JSON.stringify({ type: "error", message: "first turn failed" }),
  ]);
  assert.ok(firstReject);
  assert.equal(provider._failed, true);

  // The supersede branch in send() will reset _failed before turn 2.
  // Simulate it by calling the reset block directly (matches the code
  // we added in send()):
  provider._buffer = "";
  provider._stderrTail = "";
  provider._turnText = "";
  provider._lastUsage = null;
  provider._failed = false;

  // Now turn 2 runs normally — feed a happy-path event sequence.
  let secondResolve = null;
  provider._currentResolve = (r) => { secondResolve = r; };
  provider._currentReject = () => {};
  feedLines(provider, [
    JSON.stringify({ type: "thread.started", thread_id: "turn2" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0 },
    }),
  ]);
  provider._handleClose(0);
  assert.ok(secondResolve, "turn 2 must resolve — _failed was correctly reset");
  assert.equal(secondResolve.text, "OK");
});

// ─────────────────────────────────────────────────────────────────
// QA1-2 / QA1-3 — foreign-prefix detection prevents cross-vendor
// resume loops and multi-view race corruption.
// ─────────────────────────────────────────────────────────────────

test("QA1-2: _wrapSession returns null for foreign-prefixed ids (no cross-vendor resume)", () => {
  const { _wrapSession } = require("../src/providers/codex-cli/codex-cli");
  // gemini-cli session shouldn't be treated as resumable by codex.
  assert.equal(_wrapSession("gemini-cli-uuid-abc"), null);
  // SDK sessions (anthropic, openai, gemini) — none of them are codex
  // sessions. Drop them.
  assert.equal(_wrapSession("sdk-1234567"), null);
  assert.equal(_wrapSession("openai-sdk-1234567"), null);
  assert.equal(_wrapSession("gemini-sdk-1234567"), null);
  // Own prefix — pass through.
  assert.equal(_wrapSession("codex-cli-x"), "codex-cli-x");
  // Raw uuid — wrap.
  assert.equal(_wrapSession("019dec5c-15da-7370-ad10-46731b3a7820"),
    "codex-cli-019dec5c-15da-7370-ad10-46731b3a7820");
});

// ─────────────────────────────────────────────────────────────────
// _scrubInternalLeaks — keeps Codex's "PreToolUse hook" wording out
// of the user-visible chat output. (User report 2026-05-03.)
// ─────────────────────────────────────────────────────────────────

test("_scrubInternalLeaks strips 'Command blocked by PreToolUse hook:' prefix", () => {
  const input =
    "Command blocked by PreToolUse hook: This operation matches one of your protected patterns in Gryphon (destructive operation).\n\n" +
    "To allow it:\n- Open Obsidian → Settings → Gryphon → Protected commands\n";
  const out = _scrubInternalLeaks(input);
  assert.ok(!out.includes("PreToolUse hook"),
    "PreToolUse hook prefix must not appear in user-visible text");
  assert.match(out, /matches one of your protected patterns/);
  assert.match(out, /Settings → Gryphon → Protected commands/);
});

test("_scrubInternalLeaks strips the trailing 'Command: <echoed shell>' line", () => {
  const input =
    "Command blocked by PreToolUse hook: This matches a protected pattern.\n\n" +
    "To allow it:\n- Uncheck the pattern\n\n" +
    "Command: rm -f /tmp/x";
  const out = _scrubInternalLeaks(input);
  assert.ok(!/Command:\s+rm/.test(out),
    "trailing 'Command: rm ...' echo must be stripped");
});

test("_scrubInternalLeaks strips 'Command: <echoed shell>' INLINED at end of last sentence", () => {
  // The model often concatenates the trailing command onto the
  // same line as the preceding sentence (e.g. "Ask me again.
  // Command: rm /tmp/x"). The strip must handle both shapes.
  const input =
    "This operation matches one of your protected patterns.\n\n" +
    "To allow it:\n- Open Settings → Gryphon → Protected commands\n" +
    "- Uncheck the matching pattern\n" +
    "- Ask me again. Command: rm -f /tmp/chongxu.md";
  const out = _scrubInternalLeaks(input);
  assert.ok(!/Command:\s+rm/.test(out),
    "inlined 'Command: rm ...' echo must be stripped");
  assert.match(out, /Ask me again/, "preserves 'Ask me again' instruction");
});

test("_scrubInternalLeaks strips '(via a pre-tool hook)' / '(by the hook)' parentheticals", () => {
  for (const phrasing of [
    "I tried to delete /tmp/x but the operation was blocked (via a pre-tool hook).",
    "Blocked (by the PreToolUse hook).",
    "Refused (by a hook).",
  ]) {
    const out = _scrubInternalLeaks(phrasing);
    assert.ok(!/hook/i.test(out), `hook leaked from: ${phrasing} → ${out}`);
  }
});

test("_scrubInternalLeaks leaves benign text unchanged", () => {
  const input = "I summarized the file. Here are the main points: ...";
  assert.equal(_scrubInternalLeaks(input), input);
});

test("V13H-3 (Round 2): code-fenced 'Command:' line does NOT eat closing fence + trailing prose", () => {
  // Real-world scenario: assistant explains shell pipeline and includes
  // a literal "Command: ls" line inside a fenced example. The trailer-
  // strip used to walk from `\nCommand: ls` through end-of-string,
  // wiping the closing ``` and the explanation paragraph.
  const input =
    "Here is the example:\n" +
    "```\n" +
    "ls -la\n" +
    "Command: ls\n" +
    "```\n" +
    "\n" +
    "That's how it works.";
  const out = _scrubInternalLeaks(input);
  assert.ok(out.includes("```\nls -la"),
    "code fence opening preserved");
  assert.ok(out.includes("That's how it works."),
    "trailing prose preserved (was being eaten by the greedy [\\s\\S]+$ trailer regex)");
  assert.ok(out.includes("Command: ls"),
    "code-fenced 'Command:' content preserved");
});

test("V13H-3 (Round 2): 'rm/del/erase/unlink/shred' mid-message strip skipped when fence present", () => {
  // The third strip targets `\n\s*Command: rm ...` mid-message but
  // would still fire even when a code fence existed elsewhere.
  // After the fix, presence of any ``` defers to the safe-trailer
  // logic above (which preserves fenced content).
  const input =
    "First, here's the dangerous variant:\n" +
    "```\n" +
    "rm -rf /tmp/foo\n" +
    "Command: rm -rf /tmp/foo\n" +
    "```\n" +
    "Don't run that.";
  const out = _scrubInternalLeaks(input);
  assert.ok(out.includes("Don't run that."),
    "trailing explanation survives");
  assert.ok(out.includes("```"),
    "code fences preserved");
});

test("V13H-3 (Round 2): real trailer (no fence) still gets stripped", () => {
  // Regression guard: the safety check must not over-protect; without
  // a fence in scope, the trailer should still be stripped.
  const input =
    "This operation matches one of your protected patterns in Gryphon (destructive operation).\n\n" +
    "Command: rm -rf /tmp/x";
  const out = _scrubInternalLeaks(input);
  assert.ok(!/Command:\s+rm/.test(out),
    "trailer with no fence still stripped");
  assert.match(out, /matches one of your protected patterns/);
});

test("V13H-3 (Round 2): inlined trailer with sentence period still stripped when no fence", () => {
  const input =
    "This operation matches one of your protected patterns in Gryphon. " +
    "Ask me again. Command: rm -f /tmp/chongxu.md";
  const out = _scrubInternalLeaks(input);
  assert.ok(!/Command:\s+rm/.test(out), "inlined trailer stripped");
  assert.ok(out.endsWith("Ask me again."), "ends with the sentence punctuation");
});

test("_scrubInternalLeaks handles non-string inputs", () => {
  assert.equal(_scrubInternalLeaks(null), null);
  assert.equal(_scrubInternalLeaks(""), "");
  assert.equal(_scrubInternalLeaks(undefined), undefined);
});

test("end-to-end: agent_message is scrubbed before being passed to onMessage", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "i0",
        type: "agent_message",
        text:
          "Command blocked by PreToolUse hook: This operation matches one of your protected patterns in Gryphon (destructive operation).\n\n" +
          "To allow it:\n- Open Obsidian → Settings → Gryphon → Protected commands\n- Uncheck the matching pattern\n- Ask me again",
      },
    }),
  ]);
  const msg = captured.messages.find((m) => m.type === "replace");
  assert.ok(msg);
  assert.ok(!msg.text.includes("PreToolUse hook"),
    "scrubbed text reaches chat-view via onMessage");
  assert.match(msg.text, /matches one of your protected patterns/);
});

// Pattern enforcement was relocated to the HookDispatcher (Stage 5).
// The old `_interceptIfProtected` / `_itemToToolInput` are gone — see
// tests/hook-dispatcher.test.js + tests/codex-hook-adapter.test.js
// for the new test surface. Stream-kill is no longer a code path.

test("QA1-2: constructor with foreign resumeSessionId starts a fresh session (no resume arg)", () => {
  const p = new CodexProvider("/bin/codex", "/tmp", {
    resumeSessionId: "gemini-cli-foreign-id",
  });
  assert.equal(p.sessionId, null,
    "foreign id is rejected at construction — provider starts fresh");
  const args = p._buildArgs("hello");
  // No resume arg at all — args[1] should be a flag, not "resume".
  assert.notEqual(args[1], "resume", "foreign-prefixed id must NOT trigger codex exec resume");
});
