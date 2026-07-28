/**
 * Antigravity CLI provider (issue #19) — structured output with L6.1
 * retry budget. Mirrors gemini-cli-structured-output.test.ts (the two
 * providers share the same send()/L6.1 wiring, ported near-verbatim per
 * the provider's header comment).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@gryphon/protect") {
    return {
      hookDispatcher: {
        prepareSpawn: () => ({ ok: false, cleanup: () => {}, args: [], env: {}, degradationReason: "test-stub" }),
      },
      winSpawn: { isWindowsShim: () => false, wrapForCmdShim: (cmd: any, a: any) => ({ command: cmd, args: a, options: {} }) },
    };
  }
  if (request === "@gryphon/provider-config") {
    const pricing = {
      google: {
        computeCost: () => ({ cost: 0 }),
        coerceToVendorModel: (m: any) => m || "gemini-2.5-flash",
        DEFAULT_MODEL: "gemini-2.5-flash",
      },
    };
    return { filterExtraArgs: (a: any) => ({ filtered: a, dropped: [] }), pricing };
  }
  return origLoad.call(this, request, ...args);
};

const { AntigravityCliProvider } = require("../src/providers/antigravity-cli/antigravity-cli");

const ACTION_SCHEMA = {
  type: "object",
  properties: { action: { type: "string", enum: ["a", "b"] } },
  required: ["action"],
  additionalProperties: false,
};

test("antigravity-cli: structured output succeeds on first valid attempt", async () => {
  let callCount = 0;
  let lastSpawnPrompt: any = null;
  const provider = new AntigravityCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: (prompt: any) => {
      callCount++;
      lastSpawnPrompt = prompt;
      return Promise.resolve({
        text: '{"action":"a"}',
        sessionId: "s",
        cost: 0,
        cumulativeCost: 0,
        contextTokens: 0,
        duration: 0,
      });
    },
  });

  let onDoneResult: any = null;
  provider.onDone = (r: any) => { onDoneResult = r; };

  const result: any = await provider.send("pick", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA, maxRetries: 3 },
  });

  assert.equal(callCount, 1);
  assert.deepEqual(result.json, { action: "a" });
  assert.equal(result.text, JSON.stringify({ action: "a" }));
  assert.deepEqual(onDoneResult.json, { action: "a" });
  assert.match(lastSpawnPrompt, /JSON Schema/);
});

test("antigravity-cli: retries up to 3 times on schema failure, then throws budget-exhausted", async () => {
  const responses = ["not json at all", '{"action":"wrong_value"}', "still no good"];
  let callCount = 0;
  const provider = new AntigravityCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: () => {
      const text = responses[callCount++] || "";
      return Promise.resolve({ text, sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0, duration: 0 });
    },
  });

  let error: any = null;
  try {
    await provider.send("pick", { structuredOutput: { name: "Action", schema: ACTION_SCHEMA, maxRetries: 3 } });
  } catch (e) {
    error = e;
  }

  assert.ok(error);
  assert.equal(error.name, "CliStructuredOutputError");
  assert.equal(error.reason, "budget-exhausted");
  assert.equal(error.attempts, 3);
  assert.equal(callCount, 3);
});

test("antigravity-cli: onDone is restored after _spawnTurn rejects mid-retry", async () => {
  const sentinel = { val: "marker" };
  const provider = new AntigravityCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.reject(new Error("subprocess crashed")),
  });
  provider.onDone = sentinel;

  let crashError: any = null;
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
  assert.equal(provider.onDone, sentinel);
});

test("antigravity-cli: no structuredOutput option → plain text passthrough", async () => {
  let injectedPrompt: any = null;
  const provider = new AntigravityCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {} },
    _spawnOverride: (prompt: any) => {
      injectedPrompt = prompt;
      return Promise.resolve({ text: "hello", sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0, duration: 0 });
    },
  });

  const result: any = await provider.send("say hi");

  assert.equal(result.text, "hello");
  assert.equal(result.json, undefined);
  assert.equal(injectedPrompt, "say hi");
});
