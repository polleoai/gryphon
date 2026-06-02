/**
 * Task 2.3 — Google structured output via generationConfig.responseSchema.
 *
 * Validates:
 *   - send(prompt, { structuredOutput: { name, schema } }) passes
 *     generationConfig.responseMimeType = "application/json" and
 *     generationConfig.responseSchema = schema to the generateContentStream call.
 *   - result.json is the parsed JSON text from the model's response.
 *   - result.text is JSON.stringify(result.json).
 *   - cost and contextTokens still flow correctly.
 *   - Backwards compat: send(prompt) without options continues to work
 *     (no responseMimeType / responseSchema injected).
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
const { MockClient, usageChunk } = require("./_stubs/gemini-mock-client");

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["summarize", "fetch"] },
    source_id: { type: "integer" },
  },
  required: ["action", "source_id"],
  additionalProperties: false,
};

// Helper: build a textChunk with an optional finishReason but using a
// raw JSON string as the text (Gemini returns JSON as plain text when
// responseSchema is set).
function jsonChunk(jsonText, finishReason) {
  return {
    candidates: [{
      content: { parts: [{ text: jsonText }] },
      ...(finishReason ? { finishReason } : {}),
    }],
  };
}

// ---------- structured output: request shape ----------

test("Google: structuredOutput injects responseMimeType + responseSchema into generationConfig", async () => {
  const client = new MockClient();
  const payload = { action: "summarize", source_id: 42 };
  const jsonText = JSON.stringify(payload);

  client.queueResponse({
    chunks: [
      jsonChunk(jsonText, "STOP"),
      usageChunk({ promptTokenCount: 100, candidatesTokenCount: 20 }),
    ],
  });

  const p = new GoogleProvider("AIza-test", "/cwd", { client, model: "gemini-2.5-flash" });

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.equal(client.callCount, 1);
  const req = client.calls[0];
  assert.ok(req.config, "config must be present on the request");
  assert.equal(req.config.responseMimeType, "application/json",
    "responseMimeType must be 'application/json'");
  assert.deepEqual(req.config.responseSchema, ACTION_SCHEMA,
    "responseSchema must match the caller's schema");
});

// ---------- structured output: result shape ----------

test("Google: structuredOutput result exposes parsed .json alongside .text", async () => {
  const client = new MockClient();
  const payload = { action: "summarize", source_id: 42 };
  const jsonText = JSON.stringify(payload);

  client.queueResponse({
    chunks: [
      jsonChunk(jsonText, "STOP"),
      usageChunk({ promptTokenCount: 100, candidatesTokenCount: 20 }),
    ],
  });

  const p = new GoogleProvider("AIza-test", "/cwd", { client, model: "gemini-2.5-flash" });

  let onDoneResult = null;
  p.onDone = (r) => { onDoneResult = r; };

  await p.send("pick an action", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.deepEqual(onDoneResult.json, payload);
  assert.equal(onDoneResult.text, jsonText);
});

// ---------- cost + contextTokens ----------

test("Google: cost and contextTokens flow correctly through structured-output path", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      jsonChunk(JSON.stringify({ action: "fetch", source_id: 1 }), "STOP"),
      usageChunk({ promptTokenCount: 200, candidatesTokenCount: 30 }),
    ],
  });

  const p = new GoogleProvider("AIza-test", "/cwd", { client, model: "gemini-2.5-flash" });
  const result = await p.send("go", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  assert.ok(typeof result.cost === "number" && result.cost >= 0);
  assert.equal(result.contextTokens, 200);
});

// ---------- backwards compat: no structuredOutput ----------

test("Google: send without structuredOutput does NOT inject responseMimeType or responseSchema", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      {
        candidates: [{
          content: { parts: [{ text: "hello world" }] },
          finishReason: "STOP",
        }],
      },
      usageChunk({ promptTokenCount: 10, candidatesTokenCount: 3 }),
    ],
  });

  const p = new GoogleProvider("AIza-test", "/cwd", { client });
  const result = await p.send("plain prompt");

  assert.equal(client.callCount, 1);
  const req = client.calls[0];
  // config.responseMimeType and config.responseSchema must NOT be set
  const cfg = req.config || {};
  assert.equal(cfg.responseMimeType, undefined,
    "responseMimeType must not be set on plain sends");
  assert.equal(cfg.responseSchema, undefined,
    "responseSchema must not be set on plain sends");
  assert.equal(result.json, undefined, "result.json must be absent on plain sends");
});

// ---------- existing systemInstruction is preserved ----------

test("Google: structuredOutput does NOT clobber systemInstruction in generationConfig", async () => {
  const client = new MockClient();
  const payload = { action: "fetch", source_id: 7 };
  client.queueResponse({
    chunks: [
      jsonChunk(JSON.stringify(payload), "STOP"),
      usageChunk({ promptTokenCount: 50, candidatesTokenCount: 10 }),
    ],
  });

  const p = new GoogleProvider("AIza-test", "/cwd", { client, model: "gemini-2.5-flash" });
  await p.send("go", {
    structuredOutput: { name: "Action", schema: ACTION_SCHEMA },
  });

  const req = client.calls[0];
  // The tool loop always sets systemInstruction from the GRYPHON_GEMINI_SYSTEM_PROMPT.
  // Verify it is still present alongside the new generationConfig fields.
  assert.ok(req.config.systemInstruction,
    "systemInstruction must still be present when structuredOutput is used");
});
