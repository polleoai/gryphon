// Antigravity CLI provider (issue #19) — stream-json event parser unit
// tests. Uses the REAL wire shape, verified live against an authenticated
// `agy` v1.1.8 install (see antigravity-cli.ts's header for the full
// verification writeup) — NOT gemini-cli's shape, which the original
// issue #19 implementation wrongly assumed.
//
// We don't actually spawn `agy`; we construct an AntigravityCliProvider
// instance, feed it synthetic stream-json via _handleStdout, and assert
// the resulting state + callback emissions. The hard-timeout / real-spawn
// tests at the bottom DO spawn a real (fake, POSIX-shell) binary to prove
// the watchdog fires — gated to POSIX.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const {
  AntigravityCliProvider,
  _wrapSession,
  _unwrapSession,
  _scrubInternalLeaks,
  SESSION_PREFIX,
} = require("../src/providers/antigravity-cli/antigravity-cli");

const isWindows = process.platform === "win32";

function makeProvider(options: any = {}) {
  const p = new AntigravityCliProvider("/bin/false", "/tmp", options);
  const captured: any = { messages: [], errors: [], done: null };
  p.onMessage = (text: any, type: any) => captured.messages.push({ text, type });
  p.onError = (text: any) => captured.errors.push(text);
  p.onDone = (result: any) => { captured.done = result; };
  return { provider: p, captured };
}

function feedLines(provider: any, lines: any[]) {
  provider._handleStdout(Buffer.from(lines.join("\n") + "\n"));
}

// ─────────────────────────────────────────────────────────────────
// Session-prefix wrap/unwrap
// ─────────────────────────────────────────────────────────────────

test("session prefix is the canonical antigravity-cli marker", () => {
  assert.equal(SESSION_PREFIX, "antigravity-cli-");
});

test("_wrapSession adds prefix when missing, idempotent when present", () => {
  assert.equal(_wrapSession("abc-123"), "antigravity-cli-abc-123");
  assert.equal(_wrapSession("antigravity-cli-already-wrapped"), "antigravity-cli-already-wrapped");
  assert.equal(_wrapSession(null), null);
});

test("_unwrapSession strips prefix, leaves raw ids alone", () => {
  assert.equal(_unwrapSession("antigravity-cli-xyz"), "xyz");
  assert.equal(_unwrapSession("xyz"), "xyz");
});

// ─────────────────────────────────────────────────────────────────
// Event parser — happy path (REAL shape: { event, <event>: {...} })
// ─────────────────────────────────────────────────────────────────

test("init event captures conversation_id with prefix; no model field exists on real init", () => {
  const { provider, captured } = makeProvider({ model: "some-model" });
  const priorResolvedModel = provider.resolvedModel;
  feedLines(provider, [
    JSON.stringify({
      event: "init",
      conversation_id: "550e8400-e29b-41d4-a716-446655440000",
      init: { cwd: "/tmp", tools: [], permission_mode: "always-proceed" },
    }),
  ]);
  assert.equal(provider.sessionId, "antigravity-cli-550e8400-e29b-41d4-a716-446655440000");
  // Real init payload has no `model` field — resolvedModel must be
  // untouched by the init event (unlike gemini-cli's shape).
  assert.equal(provider.resolvedModel, priorResolvedModel);
  assert.deepEqual(captured.messages, [{ text: "", type: "init" }]);
});

test("agent_response step_update accumulates text_delta across ACTIVE + DONE for the same step_index", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "OK" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 100 } } }),
  ]);
  assert.equal(provider._turnText, "OK\n");
  // _scrubInternalLeaks trims trailing whitespace before onMessage (same
  // behavior gemini-cli's parser has) — the raw trailing "\n" survives in
  // _turnText/the final result.text but not in the streamed callback text.
  assert.deepEqual(captured.messages, [
    { text: "OK", type: "replace" },
    { text: "OK", type: "replace" },
  ]);
  assert.equal(provider.contextTokens, 100);
});

test("user_input / unknown / checkpoint step_updates carry no text and are ignored", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "unknown", duration_seconds: 0.0005 } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "checkpoint", duration_seconds: 0.5, usage: { input_tokens: 90 } } }),
  ]);
  assert.equal(provider._turnText, "");
  assert.equal(captured.messages.length, 0);
});

test("tool step_type emits the tool name as a 'tool' callback on ACTIVE only, not DONE", () => {
  const { provider, captured } = makeProvider();
  feedLines(provider, [
    JSON.stringify({ event: "step_update", step_update: { step_index: 6, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", parameters: { DirectoryPath: "/tmp" } } } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 6, state: "DONE", step_type: "tool", tool_name: "list_dir", duration_seconds: 0.19, tool_info: { name: "list_dir", parameters: { DirectoryPath: "/tmp" }, output: "file1\nfile2\n" } } }),
  ]);
  assert.deepEqual(captured.messages, [{ text: "list_dir", type: "tool" }]);
});

test("result event with status ERROR surfaces via onError and rejects immediately", () => {
  const { provider, captured } = makeProvider();
  let rejected: any = null;
  provider._currentResolve = () => {};
  provider._currentReject = (e: any) => { rejected = e; };
  provider.alive = true;
  provider.process = { kill: () => {} };
  feedLines(provider, [
    JSON.stringify({
      event: "result",
      result: { conversation_id: "", status: "ERROR", response: "", error: "boom", usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } },
    }),
  ]);
  assert.deepEqual(captured.errors, ["boom"]);
  assert.ok(rejected);
  assert.match(rejected.message, /boom/);
  assert.equal(provider._failed, true);
});

test("result event with status SUCCESS records usage as contextTokens (real field names)", () => {
  const { provider } = makeProvider();
  feedLines(provider, [
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "abc",
        status: "SUCCESS",
        response: "OK\n",
        duration_seconds: 1.5,
        num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 500, thinking_tokens: 50, cache_read_tokens: 200, total_tokens: 1500 },
      },
    }),
  ]);
  assert.equal(provider.contextTokens, 1000);
});

test("end-to-end happy-path event sequence resolves _handleClose with computed cost, preferring result.response", () => {
  const { provider, captured } = makeProvider({ model: "gemini-2.5-flash" });
  let resolved: any = null;
  provider._currentResolve = (r: any) => { resolved = r; };
  provider._currentReject = () => {};
  provider.alive = true;
  provider.process = { kill: () => {} };

  feedLines(provider, [
    JSON.stringify({ event: "init", conversation_id: "abc-1", init: { cwd: "/tmp", tools: [], permission_mode: "always-proceed" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "OK" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "", usage: { input_tokens: 1000, output_tokens: 100, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1100 } } }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "abc-1",
        status: "SUCCESS",
        response: "OK",
        duration_seconds: 0.5,
        num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 100, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1100 },
      },
    }),
  ]);
  provider._handleClose(0);

  assert.ok(resolved);
  assert.equal(resolved.text, "OK");
  assert.equal(resolved.sessionId, "antigravity-cli-abc-1");
  assert.equal(resolved.contextTokens, 1000);
  assert.equal(resolved.duration, 500);
  assert.ok(resolved.cost > 0, `cost=${resolved.cost}`);
  assert.equal(captured.done, resolved);
});

// ─────────────────────────────────────────────────────────────────
// Event parser — robustness
// ─────────────────────────────────────────────────────────────────

test("malformed JSON line is skipped (parser keeps going)", () => {
  const { provider } = makeProvider();
  provider._handleStdout(Buffer.from(
    "not json\n" + JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "Hi" } }) + "\n",
  ));
  assert.equal(provider._turnText, "Hi");
});

test("non-object events are ignored", () => {
  const { provider } = makeProvider();
  feedLines(provider, [JSON.stringify(null), JSON.stringify(42)]);
  assert.equal(provider._turnText, "");
});

// ─────────────────────────────────────────────────────────────────
// _buildArgs construction — verified real flags: --output-format
// stream-json (no -o short form) + --dangerously-skip-permissions (no
// --yes/--no-color, neither of which exist on this CLI).
// ─────────────────────────────────────────────────────────────────

test("_buildArgs always includes -p / --output-format stream-json / --dangerously-skip-permissions", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp/vault", { model: "antigravity-1" });
  const args = p._buildArgs("hello");
  assert.deepEqual(args, [
    "-p", "hello",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--model", "antigravity-1",
  ]);
});

test("_buildArgs adds --effort alongside --model only when options.effort is explicitly set", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp/vault", { model: "gemini-3.5-flash", effort: "medium" });
  const args = p._buildArgs("hello");
  const modelIdx = args.indexOf("--model");
  assert.ok(modelIdx >= 0);
  assert.equal(args[modelIdx + 1], "gemini-3.5-flash");
  const effortIdx = args.indexOf("--effort");
  assert.ok(effortIdx >= 0, "--effort should be present when options.effort is set");
  assert.equal(args[effortIdx + 1], "medium");
});

test("_buildArgs never invents a default --effort when options.effort is unset", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp/vault", { model: "gemini-3.5-flash" });
  const args = p._buildArgs("hello");
  assert.equal(args.indexOf("--effort"), -1);
});

test("_buildArgs adds --conversation with raw conversation_id (prefix stripped) — real resume flag, not --resume", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp/vault", {
    resumeSessionId: "antigravity-cli-abc-123",
  });
  const args = p._buildArgs("continue");
  const idx = args.indexOf("--conversation");
  assert.ok(idx >= 0, "--conversation should be present");
  assert.equal(args[idx + 1], "abc-123");
  assert.equal(args.indexOf("--resume"), -1, "--resume does not exist on the real CLI");
});

// ─────────────────────────────────────────────────────────────────
// _buildEnv — no API key forwarded (auth is opaque to Gryphon: silent
// keyring / OAuth per Antigravity docs, mirrors codex-cli).
// ─────────────────────────────────────────────────────────────────

test("_buildEnv forwards PATH only, no vendor API key", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp");
  const env = p._buildEnv();
  assert.equal(typeof env.PATH, "string");
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, process.env.GOOGLE_API_KEY);
});

// ─────────────────────────────────────────────────────────────────
// _scrubInternalLeaks — kept symmetric with the other three providers.
// ─────────────────────────────────────────────────────────────────

test("_scrubInternalLeaks strips 'Command blocked by ... hook:' prefix", () => {
  const out = _scrubInternalLeaks("Command blocked by BeforeTool hook: reason text");
  assert.ok(!out.includes("BeforeTool hook"));
  assert.match(out, /reason text/);
});

// ─────────────────────────────────────────────────────────────────
// Foreign-prefix detection
// ─────────────────────────────────────────────────────────────────

test("_wrapSession returns null for foreign-prefixed ids", () => {
  assert.equal(_wrapSession("codex-cli-uuid"), null);
  assert.equal(_wrapSession("gemini-cli-uuid"), null);
  assert.equal(_wrapSession("sdk-12345"), null);
  assert.equal(_wrapSession("antigravity-cli-x"), "antigravity-cli-x");
});

test("constructor with foreign resumeSessionId starts fresh (no --conversation in argv)", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp", { resumeSessionId: "gemini-cli-foreign-id" });
  assert.equal(p.sessionId, null);
  const args = p._buildArgs("hello");
  assert.equal(args.indexOf("--conversation"), -1, "foreign id must NOT trigger --conversation flag");
});

// ─────────────────────────────────────────────────────────────────
// costIsEstimate
// ─────────────────────────────────────────────────────────────────

test("costIsEstimate is true (cost computed from token counts × google pricing)", () => {
  const p = new AntigravityCliProvider("/bin/agy", "/tmp");
  assert.equal(p.costIsEstimate, true);
});

// ─────────────────────────────────────────────────────────────────
// Hard timeout watchdog (issue #19 acceptance criterion: "Hard timeout
// on every CLI call; no silent hang to the connection timeout").
// Uses a real (fake, POSIX shell) binary: responds instantly to
// --version (so resolveCliBinary's preflight probe passes) but hangs
// on any other invocation, so the watchdog is what terminates it.
// ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-agy-"));
}

function fakeHangingAgy(dir: string): string {
  const p = path.join(dir, "agy");
  fs.writeFileSync(
    p,
    "#!/bin/sh\n" +
    'if [ "$1" = "--version" ]; then echo "0.1.0"; exit 0; fi\n' +
    "sleep 30\n",
  );
  fs.chmodSync(p, 0o755);
  return p;
}

test("hard timeout: watchdog kills a hung agy and rejects with an actionable message, not a silent hang", { skip: isWindows }, async () => {
  const utils = require("../src/utils");
  utils.clearBinaryDiscoveryCache();
  const dir = tmpDir();
  const bin = fakeHangingAgy(dir);
  const p = new AntigravityCliProvider(bin, "/tmp", { antigravityTimeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(
    () => p.send("hello", {}),
    /did not respond within/i,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `watchdog must fire well before a real hang (elapsed=${elapsed}ms)`);
  assert.equal(p.isAlive(), false, "the hung process must be reaped, not leaked");
});
