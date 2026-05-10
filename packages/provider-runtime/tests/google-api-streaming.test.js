/**
 * Stage 3 (#18) GoogleProvider streaming + non-tool-use send tests.
 *
 * Validates:
 *   - Constructor + instance contract (sessionId/resolvedModel/contextTokens)
 *   - send() emits "init" then "replace" callbacks in order
 *   - Streaming snapshots accumulate from delta text parts
 *   - onDone receives normalized result with cost from pricing.js
 *   - History rolls back to checkpoint on thrown error
 *   - abort() flips destroyed=true
 *   - Error formatting (Invalid API key path)
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

const { GoogleProvider } = require("../src/providers/google-api/google-api");
const { MockClient, textChunk, usageChunk } = require("./_stubs/gemini-mock-client");

// ---------- construction ----------

test("constructor requires apiKey", () => {
  assert.throws(() => new GoogleProvider("", "/cwd"), /apiKey/);
  assert.throws(() => new GoogleProvider(null, "/cwd"), /apiKey/);
});

test("constructor sets sessionId, resolvedModel, contextTokens, isAlive", () => {
  const client = new MockClient();
  const p = new GoogleProvider("AIza-test", "/cwd", { client, model: "gemini-2.5-flash" });
  assert.ok(p.sessionId.startsWith("gemini-sdk-"));
  assert.equal(p.resolvedModel, "gemini-2.5-flash");
  assert.equal(p.contextTokens, 0);
  assert.equal(p.isAlive(), true);
  assert.equal(p.costIsEstimate, true);
});

test("constructor seeds initialHistory defensively (caller's array is not mutated)", () => {
  const client = new MockClient();
  const seed = [{ role: "user", parts: [{ text: "hi" }] }];
  const p = new GoogleProvider("AIza", "/cwd", { client, initialHistory: seed });
  p.history.push({ role: "model", parts: [{ text: "leak" }] });
  assert.equal(seed.length, 1);
  assert.equal(p.history.length, 2);
});

test("constructor translates Anthropic/OpenAI-shape seed history to Gemini shape (role 'assistant' → 'model', content → parts)", () => {
  // Regression for runtime QA finding: chat-view's _extractLlmTurnsFromFullHistory
  // produces { role: "user" | "assistant", content: <text> } entries. Gemini
  // rejects role "assistant" with INVALID_ARGUMENT 400. The provider must
  // translate at its boundary so the chat-view stays provider-agnostic.
  const client = new MockClient();
  const seed = [
    { role: "user", content: "hi there" },
    { role: "assistant", content: "hello back" },
    { role: "user", content: "what's up" },
  ];
  const p = new GoogleProvider("AIza", "/cwd", { client, initialHistory: seed });

  assert.equal(p.history.length, 3);
  assert.equal(p.history[0].role, "user");
  assert.deepEqual(p.history[0].parts, [{ text: "hi there" }]);
  // The critical fix: "assistant" → "model"
  assert.equal(p.history[1].role, "model");
  assert.deepEqual(p.history[1].parts, [{ text: "hello back" }]);
  assert.equal(p.history[2].role, "user");
  assert.deepEqual(p.history[2].parts, [{ text: "what's up" }]);

  // No "assistant" role should ever appear in Gemini-shaped history.
  for (const turn of p.history) {
    assert.ok(turn.role === "user" || turn.role === "model",
      `unexpected role: ${turn.role}`);
  }
});

test("constructor passes through already-Gemini-shaped seed history unchanged", () => {
  const client = new MockClient();
  const seed = [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hello" }] },
  ];
  const p = new GoogleProvider("AIza", "/cwd", { client, initialHistory: seed });
  assert.equal(p.history[0].role, "user");
  assert.equal(p.history[1].role, "model");
  assert.deepEqual(p.history[0].parts, [{ text: "hi" }]);
});

test("alias model resolves through pricing.resolveModel (sonnet → gemini-2.5-flash)", () => {
  const client = new MockClient();
  const p = new GoogleProvider("AIza", "/cwd", { client, model: "sonnet" });
  assert.equal(p.resolvedModel, "gemini-2.5-flash");
});

// ---------- streaming + send ----------

test("send: emits 'init' then 'replace' callbacks with cumulative snapshots", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      textChunk("Hello"),
      textChunk(" world", "STOP"),
      usageChunk({ promptTokenCount: 10, candidatesTokenCount: 2 }),
    ],
  });

  const events = [];
  const p = new GoogleProvider("AIza", "/cwd", { client, model: "gemini-2.5-flash" });
  p.onMessage = (text, type) => events.push({ text, type });

  await p.send("hi");

  assert.equal(events[0].type, "init");
  assert.equal(events[0].text, "");
  const replaceEvents = events.filter((e) => e.type === "replace");
  assert.deepEqual(replaceEvents.map((e) => e.text), ["Hello", "Hello world"]);
});

test("send: onDone receives normalized result with cost + sessionId + duration", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      textChunk("ok", "STOP"),
      usageChunk({ promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }),
    ],
  });
  let result;
  const p = new GoogleProvider("AIza", "/cwd", { client, model: "gemini-2.5-pro" });
  p.onDone = (r) => { result = r; };

  await p.send("hi");

  assert.equal(result.text, "ok");
  // gemini-2.5-pro: 1M × 1.25 + 1M × 10.00 = 11.25
  assert.equal(result.cost.toFixed(2), "11.25");
  assert.equal(result.cumulativeCost, result.cost);
  assert.ok(result.sessionId.startsWith("gemini-sdk-"));
  assert.ok(typeof result.duration === "number" && result.duration >= 0);
  assert.equal(result.contextTokens, 1_000_000);
});

test("send: cumulativeCost accumulates across multiple turns", async () => {
  const client = new MockClient();
  for (let i = 0; i < 2; i++) {
    client.queueResponse({
      chunks: [
        textChunk("x", "STOP"),
        usageChunk({ promptTokenCount: 1_000_000, candidatesTokenCount: 0 }),
      ],
    });
  }
  const p = new GoogleProvider("AIza", "/cwd", { client, model: "gemini-2.5-pro" });
  const r1 = await p.send("a");
  const r2 = await p.send("b");
  // gemini-2.5-pro input: $1.25/M
  assert.equal(r1.cumulativeCost.toFixed(2), "1.25");
  assert.equal(r2.cumulativeCost.toFixed(2), "2.50");
});

test("send: history accumulates user + model turns in Gemini shape", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [textChunk("hi back", "STOP")],
  });
  const p = new GoogleProvider("AIza", "/cwd", { client });
  await p.send("hello");
  assert.equal(p.history.length, 2);
  assert.equal(p.history[0].role, "user");
  assert.equal(p.history[0].parts[0].text, "hello");
  assert.equal(p.history[1].role, "model");
});

test("send: passes systemInstruction in config (NOT inside contents/history)", async () => {
  const client = new MockClient();
  client.queueResponse({ chunks: [textChunk("ok", "STOP")] });
  const p = new GoogleProvider("AIza", "/cwd", { client });
  await p.send("hi");
  const params = client.calls[0];
  // System instruction must be passed via config — Gemini's pattern.
  assert.ok(params.config && params.config.systemInstruction,
    "systemInstruction must be in config");
  assert.match(params.config.systemInstruction, /Gryphon/);
  // History should NOT contain a system role; only user/model.
  for (const c of params.contents) {
    assert.ok(c.role === "user" || c.role === "model",
      `unexpected role in contents: ${c.role}`);
  }
});

// ---------- error handling + rollback ----------

test("send: thrown stream error rolls history back to checkpoint", async () => {
  const client = new MockClient();
  const err = new Error("connection reset");
  err.status = 500;
  client.queueResponse({ chunks: [], error: err });

  const p = new GoogleProvider("AIza", "/cwd", { client });
  const errors = [];
  p.onError = (msg) => errors.push(msg);

  await assert.rejects(() => p.send("hi"));
  assert.equal(p.history.length, 0);
  assert.ok(errors.length > 0);
});

test("send: API_KEY_INVALID error rewritten to actionable copy", async () => {
  const client = new MockClient();
  const err = new Error("API_KEY_INVALID: Provided API key is invalid");
  err.status = 400;
  client.queueResponse({ chunks: [], error: err });

  const p = new GoogleProvider("AIza", "/cwd", { client });
  const errors = [];
  p.onError = (msg) => errors.push(msg);
  await assert.rejects(() => p.send("hi"));

  const formatted = errors[errors.length - 1];
  assert.match(formatted, /Invalid API key/);
  assert.match(formatted, /Google API key/);
});

test("send: 429 rate-limit error rewritten to actionable copy", async () => {
  const client = new MockClient();
  const err = new Error("Quota exceeded");
  err.status = 429;
  client.queueResponse({ chunks: [], error: err });

  const p = new GoogleProvider("AIza", "/cwd", { client });
  const errors = [];
  p.onError = (msg) => errors.push(msg);
  await assert.rejects(() => p.send("hi"));

  assert.match(errors[errors.length - 1], /Rate limited|quota/i);
});

// ---------- abort + isAlive ----------

test("abort: flips destroyed=true so isAlive() is false", () => {
  const client = new MockClient();
  const p = new GoogleProvider("AIza", "/cwd", { client });
  assert.equal(p.isAlive(), true);
  p.abort();
  assert.equal(p.isAlive(), false);
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});
