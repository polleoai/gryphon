/**
 * Task 2.2 — Anthropic structured output via tool-use coercion.
 *
 * Validates:
 *   - send(prompt, { structuredOutput: { name, schema } }) declares a single
 *     coercion tool as the ONLY tool, with tool_choice "auto" and an
 *     instruction to call it. Forced tool_choice ("tool"/"any") returns a 400
 *     on Fable 5.1/5.2, Opus 5.5 and Sonnet 5.5 (the default), so no model
 *     gets it.
 *   - result.json is the parsed tool_use block's input object.
 *   - result.text is JSON.stringify(result.json).
 *   - The coercion tool is NOT dispatched to Gryphon's local tool registry.
 *   - cost and contextTokens still flow correctly.
 *   - Backwards compat: send(prompt) without options continues to work.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Fake SDK client, injected via options.client, so the provider never
// loads the real SDK.
class FakeAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = {
      countTokens: async () => { throw new Error("not stubbed"); },
      stream: () => { throw new Error("stream not stubbed by default — override on instance"); },
      create: async () => { throw new Error("create not stubbed by default — override on instance"); },
    };
  }
}

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const { AnthropicAPIProvider } = require("../src/providers/anthropic-api/anthropic-api");

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["summarize", "fetch"] },
    source_id: { type: "integer" },
  },
  required: ["action", "source_id"],
  additionalProperties: false,
};

// Build a MockStream that mimics the @anthropic-ai/sdk stream interface:
//   .on("text", fn)  — registers a text-delta handler
//   .on("error", fn) — registers an error handler
//   .finalMessage()  — resolves with the canned response
//
// The stream does NOT emit text deltas for tool-use responses (the
// assistant's response consists entirely of a tool_use block — no text).
function makeMockStream({ content, stop_reason, usage, id = "msg_mock" }) {
  const handlers = {};
  return {
    on(event, fn) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(fn);
      return this;
    },
    async finalMessage() {
      return {
        id,
        content,
        stop_reason,
        usage: usage || { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
}

function makeProvider() {
  const p = new AnthropicAPIProvider("test-api-key", "/fake/cwd", {
    model: "claude-sonnet-4-6",
    client: new FakeAnthropic({ apiKey: "test-api-key", dangerouslyAllowBrowser: true, maxRetries: 3 }),
  });
  return p;
}

// ---------- structured output: request shape ----------

test("Anthropic: structuredOutput sends the coercion tool alone, unforced", async () => {
  const p = makeProvider();
  const requestsSeen = [];

  const toolUsePayload = { action: "summarize", source_id: 42 };
  p.client.messages.stream = (req) => {
    requestsSeen.push(req);
    return makeMockStream({
      content: [{ type: "tool_use", id: "tu1", name: "Action", input: toolUsePayload }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.equal(requestsSeen.length, 1);
  const req = requestsSeen[0];

  // The coercion tool is the only tool: under the old forced tool_choice the
  // other tools could never run in a structured turn, so offering only this
  // one keeps that behaviour without forcing.
  assert.ok(Array.isArray(req.tools), "tools must be an array");
  assert.deepEqual(req.tools.map((t) => t.name), ["Action"]);
  const coercionTool = req.tools[0];
  assert.match(coercionTool.description, /Return the structured response/);
  assert.match(coercionTool.description, /always call this tool/i);
  assert.deepEqual(coercionTool.input_schema, ACTION_SCHEMA);

  assert.ok(req.tool_choice, "tool_choice must be set");
  assert.equal(req.tool_choice.type, "auto");
});

test("Anthropic: no registry model gets a forced tool_choice for structured output", async () => {
  const registry = require("../../provider-config/src/registry");
  const ids = registry.modelsByVendor("anthropic").map((m) => m.id);
  assert.ok(ids.includes("claude-sonnet-5-5"), "registry lookup sanity");
  for (const model of ids) {
    const seen = [];
    const p = new AnthropicAPIProvider("test-api-key", "/fake/cwd", {
      model,
      client: new FakeAnthropic({ apiKey: "test-api-key", dangerouslyAllowBrowser: true, maxRetries: 3 }),
    });
    p.client.messages.stream = (req) => {
      seen.push(req);
      return makeMockStream({
        content: [{ type: "tool_use", id: "tu1", name: "Action", input: { action: "fetch", source_id: 1 } }],
        stop_reason: "tool_use",
      });
    };
    await p.send("go", { structuredOutput: { name: "Action", schema: ACTION_SCHEMA } });
    const choice = seen[0].tool_choice;
    assert.ok(!choice || !["tool", "any"].includes(choice.type),
      `${model}: tool_choice ${JSON.stringify(choice)} is rejected on current models`);
  }
});

// ---------- structured output: result shape ----------

test("Anthropic: structuredOutput result exposes parsed .json and serialized .text", async () => {
  const p = makeProvider();
  const payload = { action: "summarize", source_id: 42 };

  p.client.messages.stream = (_req) => {
    return makeMockStream({
      content: [{ type: "tool_use", id: "tu1", name: "Action", input: payload }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };

  let onDoneResult = null;
  p.onDone = (r) => { onDoneResult = r; };

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.deepEqual(onDoneResult.json, payload);
  assert.equal(onDoneResult.text, JSON.stringify(payload));
});

// ---------- coercion tool NOT dispatched to local registry ----------

test("Anthropic: coercion tool block is NOT dispatched to Gryphon's tool registry", async () => {
  // The tool registry is used to execute real Gryphon tools (read_file,
  // write_file, etc.). A coercion tool_use block must NOT be routed there —
  // it is purely an output channel. We verify this by checking that only
  // ONE API call was made (no second iteration from dispatching + looping).
  const p = makeProvider();
  let callCount = 0;

  p.client.messages.stream = (_req) => {
    callCount++;
    return makeMockStream({
      content: [{ type: "tool_use", id: "tu1", name: "Action", input: { action: "fetch", source_id: 7 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 10 },
    });
  };

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.equal(callCount, 1,
    "Only one API call must be made — coercion tool must NOT trigger a second loop iteration");
});

// ---------- cost + contextTokens ----------

test("Anthropic: cost and contextTokens flow correctly through structured-output path", async () => {
  const p = makeProvider();

  p.client.messages.stream = (_req) => {
    return makeMockStream({
      content: [{ type: "tool_use", id: "tu1", name: "Action", input: { action: "fetch", source_id: 1 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 200, output_tokens: 50 },
    });
  };

  const result = await p.send("go", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.ok(typeof result.cost === "number" && result.cost > 0,
    "cost must be a positive number");
  // contextTokens uses input_tokens (peak window occupancy)
  assert.equal(result.contextTokens, 200);
});

// ---------- coercion failure: end_turn without tool_use ----------

test("structuredOutput: throws clearly when Anthropic ignores tool_choice and returns end_turn", async () => {
  // SDK stub that returns end_turn (no tool_use block), simulating
  // an API that ignored the forced tool_choice.
  const p = makeProvider();

  p.client.messages.stream = (_req) => {
    return makeMockStream({
      content: [{ type: "text", text: "I am not using the tool today" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20 },
    });
  };

  let err = null;
  try {
    await p.send("prompt", {
      structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw when coercion fails");
  assert.equal(err.code, "STRUCTURED_OUTPUT_COERCION_FAILED");
  assert.match(err.message, /Anthropic/);
  assert.match(err.message, /Action/);
  assert.match(err.message, /end_turn/);
});

// ---------- backwards compat ----------

test("Anthropic: send without structuredOutput does NOT inject coercion tool or tool_choice", async () => {
  const p = makeProvider();
  const requestsSeen = [];

  p.client.messages.stream = (req) => {
    requestsSeen.push(req);
    return makeMockStream({
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };

  const result = await p.send("plain prompt");

  assert.equal(requestsSeen.length, 1);
  const req = requestsSeen[0];
  // tool_choice must NOT be set (it would force the model to always call a tool)
  assert.equal(req.tool_choice, undefined,
    "tool_choice must not be set on plain sends");
  // No coercion tool in tools[] (other Gryphon tools may be present, but no
  // tool with a description of "Return the structured response.")
  const coercionTool = (req.tools || []).find(
    (t) => t.description === "Return the structured response.",
  );
  assert.equal(coercionTool, undefined,
    "coercion tool must not be present on plain sends");
  assert.equal(result.json, undefined, "result.json must be absent on plain sends");
});

// ---------- one bounded retry when the model answers in text ----------
// tool_choice "auto" no longer guarantees a tool call: a clarifying question
// or a refusal ends the turn in text. The loop re-asks once with a nudge to
// call the tool; a second text answer still fails.

function snapshotRequests(p, responses) {
  const seen = [];
  p.client.messages.stream = (req) => {
    seen.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    return makeMockStream(responses[Math.min(seen.length - 1, responses.length - 1)]);
  };
  return seen;
}

const TEXT_REPLY = {
  content: [{ type: "text", text: "Which source do you mean?" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 50, output_tokens: 10 },
};
const TOOL_REPLY = {
  content: [{ type: "tool_use", id: "tu9", name: "Action", input: { action: "summarize", source_id: 42 } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 70, output_tokens: 15 },
};

test("structuredOutput: a text answer gets one nudge, then the tool call is returned", async () => {
  const p = makeProvider();
  const seen = snapshotRequests(p, [TEXT_REPLY, TOOL_REPLY]);

  const result = await p.send("pick an action", { structuredOutput: { name: "Action", schema: ACTION_SCHEMA } });

  assert.equal(seen.length, 2, "exactly one retry");
  assert.deepEqual(result.json, { action: "summarize", source_id: 42 });
  const retry = seen[1];
  assert.deepEqual(retry.tools.map((t) => t.name), ["Action"], "retry still offers only the coercion tool");
  assert.equal(retry.tool_choice.type, "auto");
  const last = retry.messages[retry.messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last.content), /Action/, "the nudge names the tool");
  const prev = retry.messages[retry.messages.length - 2];
  assert.equal(prev.role, "assistant", "the text answer stays in the history");
});

test("structuredOutput: the retry is bounded — a second text answer still fails", async () => {
  const p = makeProvider();
  const seen = snapshotRequests(p, [TEXT_REPLY, TEXT_REPLY, TOOL_REPLY]);

  let err = null;
  try {
    await p.send("pick an action", { structuredOutput: { name: "Action", schema: ACTION_SCHEMA } });
  } catch (e) { err = e; }

  assert.ok(err, "must throw");
  assert.equal(err.code, "STRUCTURED_OUTPUT_COERCION_FAILED");
  assert.equal(seen.length, 2, "one retry, not more");
});

test("send without structuredOutput: a text answer is final (no nudge)", async () => {
  const p = makeProvider();
  const seen = snapshotRequests(p, [TEXT_REPLY, TOOL_REPLY]);
  await p.send("hello");
  assert.equal(seen.length, 1);
});

test("structuredOutput: works after earlier tool_use turns, offering only the coercion tool", async () => {
  // A chat that already used Gryphon's tools, then a structured turn. The
  // history keeps the old Read tool_use / tool_result pair; the request
  // offers only the coercion tool.
  const p = new AnthropicAPIProvider("test-api-key", "/fake/cwd", {
    model: "claude-sonnet-5-5",
    client: new FakeAnthropic({ apiKey: "test-api-key", dangerouslyAllowBrowser: true, maxRetries: 3 }),
    initialHistory: [
      { role: "user", content: "read notes.md" },
      { role: "assistant", content: [{ type: "tool_use", id: "tr1", name: "Read", input: { file_path: "notes.md" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tr1", content: "source 42: long article" }] },
      { role: "assistant", content: [{ type: "text", text: "It lists source 42." }] },
    ],
  });
  const seen = snapshotRequests(p, [TOOL_REPLY]);

  const result = await p.send("pick an action", { structuredOutput: { name: "Action", schema: ACTION_SCHEMA } });

  assert.deepEqual(result.json, { action: "summarize", source_id: 42 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tools.map((t) => t.name), ["Action"]);
  const kinds = seen[0].messages.flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.type) : []));
  assert.ok(kinds.includes("tool_use") && kinds.includes("tool_result"), "earlier tool blocks are sent as history");
});
