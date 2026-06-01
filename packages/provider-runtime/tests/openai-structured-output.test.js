/**
 * Task 2.1 — OpenAI structured output via json_schema response_format.
 *
 * Validates:
 *   - send(prompt, { structuredOutput: { name, schema } }) passes
 *     response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }
 *     to the underlying chat.completions call.
 *   - result.json is the parsed object from the model's JSON text response.
 *   - result.text is the JSON-stringified version of result.json.
 *   - cost and contextTokens still flow correctly through the structured-output path.
 *   - Backwards compat: send(prompt) without options continues to work (no response_format).
 *   - Defensive JSON parse failure: if the model returns invalid JSON under
 *     structured output, the error is surfaced via onError rather than crashing.
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

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["summarize", "fetch"] },
    source_id: { type: "integer" },
  },
  required: ["action", "source_id"],
  additionalProperties: false,
};

// Helper: wire up a MockClient with a single canned completion whose text
// is the given JSON string.
function makeProviderWithJsonResponse(jsonText) {
  const client = new MockClient();
  client.queueResponse({
    chunks: [jsonText],
    completion: {
      id: "chatcmpl-so-test",
      choices: [{
        index: 0,
        message: { role: "assistant", content: jsonText },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  });
  const p = new OpenAIProvider("sk-test", "/cwd", { client, model: "gpt-5.4-mini" });
  return { p, client };
}

// ---------- structured output: request shape ----------

test("OpenAI: structuredOutput option injects response_format into the API call", async () => {
  const { p, client } = makeProviderWithJsonResponse(
    JSON.stringify({ action: "summarize", source_id: 42 }),
  );

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.equal(client.callCount, 1);
  const req = client.calls[0];
  assert.ok(req.response_format, "response_format must be present on the request");
  assert.equal(req.response_format.type, "json_schema");
  assert.equal(req.response_format.json_schema.name, "Action");
  assert.deepEqual(req.response_format.json_schema.schema, ACTION_SCHEMA);
  assert.equal(req.response_format.json_schema.strict, true);
});

// ---------- structured output: result shape ----------

test("OpenAI: structuredOutput result exposes parsed .json alongside .text", async () => {
  const payload = { action: "summarize", source_id: 42 };
  const { p } = makeProviderWithJsonResponse(JSON.stringify(payload));

  let onDoneResult = null;
  p.onDone = (r) => { onDoneResult = r; };

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.deepEqual(onDoneResult.json, payload);
  assert.equal(onDoneResult.text, JSON.stringify(payload));
});

test("OpenAI: cost and contextTokens are present in a structured-output result", async () => {
  const { p } = makeProviderWithJsonResponse(JSON.stringify({ action: "fetch", source_id: 1 }));

  const result = await p.send("go", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  // gpt-5.4-mini: any positive cost is fine; we just need it non-zero for 100 prompt tokens
  assert.ok(typeof result.cost === "number" && result.cost >= 0);
  assert.equal(result.contextTokens, 100);
});

// ---------- backwards compat: no structuredOutput ----------

test("OpenAI: send without structuredOutput does NOT set response_format", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["hello"],
    completion: {
      id: "chatcmpl-plain",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    },
  });
  const p = new OpenAIProvider("sk-test", "/cwd", { client });

  const result = await p.send("plain prompt");

  assert.equal(client.callCount, 1);
  const req = client.calls[0];
  assert.equal(req.response_format, undefined,
    "response_format must not be set when structuredOutput is absent");
  assert.equal(result.json, undefined, "result.json must be absent on plain sends");
});

// ---------- defensive: malformed JSON from model ----------

test("OpenAI: malformed JSON under structuredOutput surfaces via onError without crashing", async () => {
  const { p } = makeProviderWithJsonResponse("not valid JSON {{");

  const errors = [];
  p.onError = (msg) => errors.push(msg);

  // Should not throw — the loop catches the parse failure and routes it through onError.
  try {
    await p.send("pick an action", {
      structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
    });
  } catch (_) {
    // Acceptable to throw after calling onError; what we must NOT do is
    // crash without calling onError.
  }

  assert.ok(errors.length > 0, "onError must be called on malformed JSON");
  assert.ok(
    errors.some((e) => /json|parse|invalid/i.test(e)),
    `Expected JSON-parse error message, got: ${errors.join(", ")}`,
  );
});
