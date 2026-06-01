/**
 * Task 3.2 — ClaudeCodeProvider structured output with L6.1 retry budget.
 *
 * Validates:
 *   - send(prompt, { structuredOutput: { name, schema, maxRetries } })
 *     injects the schema hint into the prompt, calls _spawnOverride once
 *     on a valid response, and returns result.json + result.text.
 *   - Retries up to maxRetries on bad responses, then throws
 *     CliStructuredOutputError(reason: "budget-exhausted", attempts: N).
 *   - Backwards compat: send(prompt) without options → plain text passthrough.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian before any provider require.
const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

// Stub @gryphon/protect and @gryphon/provider-config so the provider module
// loads without the real Obsidian plugin infra.
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@gryphon/protect") {
    return {
      buildDisallowedTools: () => [],
      winSpawn: { isWindowsShim: () => false, wrapForCmdShim: (cmd, a) => ({ command: cmd, args: a, options: {} }) },
      GRYPHON_SYSTEM_PROMPT_HINT: "[gryphon-hint]",
      GRYPHON_FALLBACK_DENY_HINT: "[gryphon-fallback]",
    };
  }
  if (request === "@gryphon/provider-config") {
    return { filterExtraArgs: (a) => ({ filtered: a, dropped: [] }) };
  }
  return origLoad.call(this, request, ...args);
};

const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["a", "b"] },
  },
  required: ["action"],
  additionalProperties: false,
};

// ---------- happy path ----------

test("claude-code: structured output succeeds on first valid attempt", async () => {
  let callCount = 0;
  let lastSpawnPrompt = null;
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: (prompt) => {
      callCount++;
      lastSpawnPrompt = prompt;
      return Promise.resolve({
        text: '{"action":"a"}',
        sessionId: "s",
        cost: 0,
        cumulativeCost: 0,
        contextTokens: 0,
      });
    },
  });

  let onDoneResult = null;
  provider.onDone = (r) => { onDoneResult = r; };

  const result = await provider.send("pick", {
    structuredOutput: {
      name: "Action",
      schema: ACTION_SCHEMA,
      maxRetries: 3,
    },
  });

  assert.equal(callCount, 1, "spawn called exactly once");
  assert.deepEqual(result.json, { action: "a" });
  assert.equal(result.text, JSON.stringify({ action: "a" }));
  assert.deepEqual(onDoneResult.json, { action: "a" });
  assert.equal(onDoneResult.text, JSON.stringify({ action: "a" }));
  // Schema hint must have been injected into the prompt.
  assert.match(lastSpawnPrompt, /JSON Schema/, "prompt must contain 'JSON Schema'");
  assert.match(lastSpawnPrompt, /Action/, "prompt must contain schema name 'Action'");
});

// ---------- retry-then-fail ----------

test("claude-code: retries up to 3 times on schema failure, then throws budget-exhausted", async () => {
  const responses = ["not json at all", '{"action":"wrong_value"}', "still no good"];
  let callCount = 0;
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: () => {
      const text = responses[callCount++] || "";
      return Promise.resolve({ text, sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0 });
    },
  });

  let error = null;
  try {
    await provider.send("pick", {
      structuredOutput: {
        name: "Action",
        schema: ACTION_SCHEMA,
        maxRetries: 3,
      },
    });
  } catch (e) {
    error = e;
  }

  assert.ok(error, "should throw");
  assert.equal(error.name, "CliStructuredOutputError");
  assert.equal(error.reason, "budget-exhausted");
  assert.equal(error.attempts, 3);
  assert.equal(callCount, 3, "should have attempted exactly 3 times");
});

// ---------- regression: onDone restored after _spawnTurn rejects ----------

test("claude-code: onDone is restored after _doOneTurn rejects mid-retry (regression for null-onDone leak)", async () => {
  const sentinel = { val: "marker" };
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.reject(new Error("subprocess crashed")),
  });
  provider.onDone = sentinel;

  let crashError = null;
  try {
    await provider.send("prompt", {
      structuredOutput: {
        name: "Action",
        schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        maxRetries: 3,
      },
    });
  } catch (e) {
    crashError = e;
  }
  assert.ok(crashError);
  assert.match(crashError.message, /subprocess crashed/);

  // Critical: this.onDone must still be the sentinel — the bug was that it would be null here.
  assert.equal(provider.onDone, sentinel,
    "onDone must be restored even when _doOneTurn rejects (try/finally guard)");
});

// ---------- backwards compat ----------

test("claude-code: no structuredOutput option → plain text passthrough", async () => {
  let injectedPrompt = null;
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: (prompt) => {
      injectedPrompt = prompt;
      return Promise.resolve({ text: "hello", sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0 });
    },
  });

  let onDoneResult = null;
  provider.onDone = (r) => { onDoneResult = r; };

  const result = await provider.send("say hi");

  assert.equal(result.text, "hello");
  assert.equal(result.json, undefined, "result.json must be absent on plain sends");
  assert.equal(injectedPrompt, "say hi", "no schema-injection prefix when option absent");
  // onDone is NOT called by _doOneTurn when _spawnOverride is used —
  // the override just resolves; the caller (send) returns directly. The
  // real CC path fires onDone via _processEvent. This test verifies that
  // the plain-send path does NOT try to inject a schema hint.
});
