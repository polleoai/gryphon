/**
 * Task 2.2 — Anthropic structured output via tool-use coercion.
 *
 * Validates:
 *   - send(prompt, { structuredOutput: { name, schema } }) declares a single
 *     coercion tool and sets tool_choice: { type: "tool", name } on the request.
 *   - result.json is the parsed tool_use block's input object.
 *   - result.text is JSON.stringify(result.json).
 *   - The coercion tool is NOT dispatched to Gryphon's local tool registry.
 *   - cost and contextTokens still flow correctly.
 *   - Backwards compat: send(prompt) without options continues to work.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub the Anthropic SDK before requiring the provider — we inject a
// fake client so the constructor doesn't touch the real SDK.
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

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@anthropic-ai/sdk") return { default: FakeAnthropic };
  return originalLoad.call(this, request, ...args);
};

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
  });
  return p;
}

// ---------- structured output: request shape ----------

test("Anthropic: structuredOutput adds coercion tool + forced tool_choice to the stream request", async () => {
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

  // The coercion tool must be in tools[]
  assert.ok(Array.isArray(req.tools), "tools must be an array");
  const coercionTool = req.tools.find((t) => t.name === "Action");
  assert.ok(coercionTool, "coercion tool 'Action' must be in tools[]");
  assert.equal(coercionTool.description, "Return the structured response.");
  assert.deepEqual(coercionTool.input_schema, ACTION_SCHEMA);

  // tool_choice must force the coercion tool
  assert.ok(req.tool_choice, "tool_choice must be set");
  assert.equal(req.tool_choice.type, "tool");
  assert.equal(req.tool_choice.name, "Action");
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
