/**
 * Stage 2 (#17) OpenAIProvider streaming + non-tool-use send tests.
 *
 * Validates:
 *   - Constructor + instance contract (sessionId/resolvedModel/contextTokens)
 *   - send() emits "init" then "replace" callbacks in order
 *   - Streaming snapshots are forwarded verbatim (no double-accumulation)
 *   - onDone receives a normalized result with cost from pricing.js
 *   - History is rolled back to checkpoint on thrown error
 *   - abort() flips destroyed=true and stops the stream
 *   - Authentication-style error gets the actionable message
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

const { OpenAIProvider } = require("../src/providers/openai-api/openai-api");
const { MockClient } = require("./_stubs/openai-mock-client");

function makeChatCompletion({ text = "", finish_reason = "stop", usage, tool_calls } = {}) {
  const message = { role: "assistant", content: text };
  if (tool_calls) message.tool_calls = tool_calls;
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0 },
  };
}

// ---------- construction ----------

test("constructor requires apiKey", () => {
  assert.throws(() => new OpenAIProvider("", "/cwd"), /apiKey/);
  assert.throws(() => new OpenAIProvider(null, "/cwd"), /apiKey/);
});

test("constructor sets sessionId, resolvedModel, contextTokens, isAlive", () => {
  const client = new MockClient();
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "gpt-4o-mini" });
  assert.ok(p.sessionId.startsWith("openai-sdk-"));
  assert.equal(p.resolvedModel, "gpt-4o-mini");
  assert.equal(p.contextTokens, 0);
  assert.equal(p.isAlive(), true);
  assert.equal(p.costIsEstimate, true);
});

test("constructor seeds initialHistory defensively (caller's array is not mutated)", () => {
  const client = new MockClient();
  const seed = [{ role: "user", content: "hi" }];
  const p = new OpenAIProvider("sk-test", "/cwd", { client, initialHistory: seed });
  p.history.push({ role: "assistant", content: "leak" });
  assert.equal(seed.length, 1, "caller's history must be untouched");
  assert.equal(p.history.length, 2);
});

test("alias model resolves through pricing.resolveModel (sonnet → gpt-5.4-mini, the new balanced tier)", () => {
  const client = new MockClient();
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "sonnet" });
  assert.equal(p.resolvedModel, "gpt-5.4-mini");
});

// ---------- streaming + send ----------

test("send: emits 'init' then 'replace' callbacks in correct order", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["Hello", " world"],
    completion: makeChatCompletion({
      text: "Hello world",
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  });

  const events = [];
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "gpt-4o" });
  p.onMessage = (text, type) => events.push({ text, type });

  await p.send("hi");

  // First event must be init (empty text), then replace events with snapshots
  assert.equal(events[0].type, "init");
  assert.equal(events[0].text, "");
  // Subsequent events must be "replace" with cumulative snapshots
  const replaceEvents = events.filter((e) => e.type === "replace");
  assert.deepEqual(replaceEvents.map((e) => e.text), ["Hello", "Hello world"]);
});

test("send: forwards snapshots verbatim — no double-accumulation", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["A", "B", "C"],
    completion: makeChatCompletion({ text: "ABC" }),
  });
  const seen = [];
  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  p.onMessage = (text, type) => { if (type === "replace") seen.push(text); };

  await p.send("x");
  assert.deepEqual(seen, ["A", "AB", "ABC"]);
});

test("send: onDone receives normalized result with cost + sessionId + duration", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["hi"],
    completion: makeChatCompletion({
      text: "hi",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    }),
  });
  let result;
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "gpt-4o" });
  p.onDone = (r) => { result = r; };

  await p.send("hi");

  assert.equal(result.text, "hi");
  // gpt-4o: 1M × 2.50 + 1M × 10.00 = 12.50
  assert.equal(result.cost.toFixed(2), "12.50");
  assert.equal(result.cumulativeCost, result.cost);
  assert.ok(result.sessionId.startsWith("openai-sdk-"));
  assert.ok(typeof result.duration === "number" && result.duration >= 0);
  assert.equal(result.contextTokens, 1_000_000);
});

test("send: cumulativeCost accumulates across multiple turns", async () => {
  const client = new MockClient();
  for (let i = 0; i < 2; i++) {
    client.queueResponse({
      chunks: ["x"],
      completion: makeChatCompletion({
        text: "x",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, // gpt-4o: $2.50
      }),
    });
  }
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "gpt-4o" });
  const r1 = await p.send("a");
  const r2 = await p.send("b");
  assert.equal(r1.cumulativeCost.toFixed(2), "2.50");
  assert.equal(r2.cumulativeCost.toFixed(2), "5.00");
});

test("send: history accumulates user + assistant turns", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["hi"],
    completion: makeChatCompletion({ text: "hi back" }),
  });
  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  await p.send("hello");
  // user, assistant
  assert.equal(p.history.length, 2);
  assert.equal(p.history[0].role, "user");
  assert.equal(p.history[0].content, "hello");
  assert.equal(p.history[1].role, "assistant");
});

// ---------- error handling + rollback ----------

test("send: thrown stream error rolls history back to checkpoint", async () => {
  const client = new MockClient();
  const err = new Error("network unreachable");
  err.status = 500;
  client.queueResponse({ error: err, completion: null });

  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  const errors = [];
  p.onError = (msg) => errors.push(msg);

  await assert.rejects(() => p.send("hi"));
  assert.equal(p.history.length, 0, "history must be rolled back to pre-turn state");
  assert.ok(errors.length > 0, "onError must be called");
  assert.match(errors[0], /OpenAI API error|network unreachable/);
});

test("send: AuthenticationError is rewritten to actionable copy", async () => {
  const client = new MockClient();
  // Mimic the SDK's AuthenticationError shape — the formatter sniffs constructor.name
  class AuthenticationError extends Error {}
  Object.defineProperty(AuthenticationError, "name", { value: "AuthenticationError" });
  const err = new AuthenticationError("Invalid Authentication");
  Object.setPrototypeOf(err, AuthenticationError.prototype);
  err.status = 401;
  client.queueResponse({ error: err, completion: null });

  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  const errors = [];
  p.onError = (msg) => errors.push(msg);
  await assert.rejects(() => p.send("hi"));

  // onError fires twice: once raw (from stream.on("error")) and once
  // formatted (from _formatError in send's catch). The last call carries
  // the actionable user-facing message — that's what the chat bubble shows.
  const formatted = errors[errors.length - 1];
  assert.match(formatted, /Invalid API key/);
  assert.match(formatted, /OpenAI API key/);
});

// ---------- abort + isAlive ----------

test("abort: flips destroyed=true so isAlive() is false", () => {
  const client = new MockClient();
  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  assert.equal(p.isAlive(), true);
  p.abort();
  assert.equal(p.isAlive(), false);
});

test("abort during pending send: aborts the active stream", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["A", "B"],
    completion: makeChatCompletion({ text: "AB" }),
  });
  const p = new OpenAIProvider("sk-test", "/cwd", { client });
  // Start send (don't await yet)
  const promise = p.send("hi").catch(() => {}); // will reject when aborted
  // Tick the event loop so stream is created
  await new Promise((r) => setImmediate(r));
  p.abort();
  await promise;
  assert.equal(p.isAlive(), false);
});

// ---------- restore module resolver ----------

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});
