/**
 * Stage 3 (#18) Gemini tool-loop multi-turn driver tests.
 *
 * Validates:
 *   - Pure text response: 1 iteration, history grows by 1 (model turn)
 *   - System prompt is passed via config.systemInstruction (not history)
 *   - functionCall part dispatches via executeTool, appends user-role
 *     functionResponse turn, iterates
 *   - Multi-tool single turn: parallel functionCalls handled in order
 *   - Usage aggregation across iterations
 *   - MAX_ITERATIONS safety rail
 *   - serializeToolResultAsGeminiResponse: result/error envelope shape
 *   - Unknown-tool dispatch reaches the registry (proves no bypass)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const {
  runGeminiToolLoop,
  MAX_ITERATIONS,
  serializeToolResultAsGeminiResponse,
} = require("../src/providers/google-api/tool-loop");
const { MockClient, textChunk, usageChunk } = require("./_stubs/gemini-mock-client");

function tmpVault() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-gemini-loop-")));
}

function functionCallTurn(name, args, id) {
  const fc = { name, args };
  if (id) fc.id = id;
  return {
    chunks: [{
      candidates: [{
        content: { parts: [{ functionCall: fc }] },
        finishReason: "STOP",
      }],
    }],
  };
}

// ---------- serializeToolResultAsGeminiResponse ----------

test("serializer: array-of-blocks → { result: 'joined', success: true }", () => {
  const r = { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] };
  assert.deepEqual(serializeToolResultAsGeminiResponse(r), { result: "Hello world", success: true });
});

test("serializer: isError=true → { result: body, success: false } (NOT a field literally named 'error')", () => {
  // Field name `error` was renamed to `success: false` because Gemini's
  // model treated the literal key name as a presentational tag and
  // prepended "Error: " to the content when echoing it back to the
  // user. With `success: false` plus the body in `result`, the model
  // reads the failure as state and quotes the body cleanly.
  const r = { content: [{ type: "text", text: "denied" }], isError: true };
  assert.deepEqual(serializeToolResultAsGeminiResponse(r), { result: "denied", success: false });
});

test("serializer: null/undefined → { result: '', success: true }", () => {
  assert.deepEqual(serializeToolResultAsGeminiResponse(null), { result: "", success: true });
  assert.deepEqual(serializeToolResultAsGeminiResponse(undefined), { result: "", success: true });
});

test("serializer: string content passes through as result with success: true", () => {
  assert.deepEqual(serializeToolResultAsGeminiResponse({ content: "hello" }), { result: "hello", success: true });
});

// ---------- single-turn (no tool calls) ----------

test("loop: pure text response — single iteration, history grows by 1 (model turn)", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [textChunk("hello back", "STOP"), usageChunk({ promptTokenCount: 5, candidatesTokenCount: 2 })],
  });

  const history = [{ role: "user", parts: [{ text: "hi" }] }];
  const result = await runGeminiToolLoop({
    client,
    model: "gemini-2.5-flash",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: tmpVault(), permissionMode: "default" },
    callbacks: {},
  });

  assert.equal(result.iterations, 1);
  assert.equal(result.turnText, "hello back");
  assert.equal(history.length, 2);
  assert.equal(history[1].role, "model");
});

test("loop: system prompt is in config.systemInstruction (NOT in history)", async () => {
  const client = new MockClient();
  client.queueResponse({ chunks: [textChunk("ok", "STOP")] });
  const history = [{ role: "user", parts: [{ text: "hi" }] }];
  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "you are gryphon",
    history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });
  const params = client.calls[0];
  assert.equal(params.config.systemInstruction, "you are gryphon");
  // No system roles in contents
  for (const c of params.contents) {
    assert.ok(c.role === "user" || c.role === "model", `unexpected role: ${c.role}`);
  }
});

// ---------- multi-turn tool use ----------

test("loop: functionCall dispatches via executeTool, appends functionResponse turn, iterates", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "hello.txt"), "world");

  const client = new MockClient();
  // Iteration 1: model emits functionCall for Read
  client.queueResponse(functionCallTurn("Read", { file_path: "hello.txt" }, "call-1"));
  // Iteration 2: model returns text
  client.queueResponse({
    chunks: [textChunk("the file says world", "STOP"), usageChunk({ promptTokenCount: 100, candidatesTokenCount: 5 })],
  });

  const history = [{ role: "user", parts: [{ text: "read hello.txt" }] }];
  const toolNames = [];
  const result = await runGeminiToolLoop({
    client,
    model: "gemini-2.5-pro",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default" },
    callbacks: { onTool: (n) => toolNames.push(n) },
  });

  assert.equal(result.iterations, 2);
  assert.deepEqual(toolNames, ["Read"]);
  // History after: user, model(functionCall), user(functionResponse), model(text)
  assert.equal(history.length, 4);
  assert.equal(history[1].role, "model");
  assert.ok(history[1].parts[0].functionCall, "model turn must carry functionCall");
  assert.equal(history[2].role, "user");
  assert.ok(history[2].parts[0].functionResponse, "tool result turn must carry functionResponse");
  assert.equal(history[2].parts[0].functionResponse.name, "Read");
  assert.match(history[2].parts[0].functionResponse.response.result, /world/);
  assert.equal(history[3].role, "model");
});

test("loop: parallel functionCalls in one turn dispatch in order, single user-role response", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "a.txt"), "AAA");
  fs.writeFileSync(path.join(vault, "b.txt"), "BBB");

  const client = new MockClient();
  // Iteration 1: model emits two functionCalls in one turn
  client.queueResponse({
    chunks: [{
      candidates: [{
        content: { parts: [
          { functionCall: { name: "Read", args: { file_path: "a.txt" }, id: "c-a" } },
          { functionCall: { name: "Read", args: { file_path: "b.txt" }, id: "c-b" } },
        ] },
        finishReason: "STOP",
      }],
    }],
  });
  // Iteration 2: text
  client.queueResponse({ chunks: [textChunk("done", "STOP")] });

  const history = [{ role: "user", parts: [{ text: "read both" }] }];
  const toolNames = [];
  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: vault, permissionMode: "default" },
    callbacks: { onTool: (n) => toolNames.push(n) },
  });

  assert.deepEqual(toolNames, ["Read", "Read"]);
  // History: user, model(2 functionCalls), user(2 functionResponses), model(text)
  assert.equal(history.length, 4);
  // Critical: the two functionResponses must be in a SINGLE user turn
  // (Gemini's contract — not two separate user turns).
  const responseTurn = history[2];
  assert.equal(responseTurn.role, "user");
  assert.equal(responseTurn.parts.length, 2);
  assert.match(responseTurn.parts[0].functionResponse.response.result, /AAA/);
  assert.match(responseTurn.parts[1].functionResponse.response.result, /BBB/);
});

// ---------- usage aggregation ----------

test("loop: prompt+candidates token counts aggregate across iterations", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "x.txt"), "x");

  const client = new MockClient();
  // Iteration 1: functionCall + usage
  client.queueResponse({
    chunks: [
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: "Read", args: { file_path: "x.txt" } } }] },
          finishReason: "STOP",
        }],
      },
      usageChunk({ promptTokenCount: 100, candidatesTokenCount: 50 }),
    ],
  });
  // Iteration 2: text + usage with cached tokens
  client.queueResponse({
    chunks: [
      textChunk("done", "STOP"),
      usageChunk({ promptTokenCount: 200, candidatesTokenCount: 25, cachedContentTokenCount: 50 }),
    ],
  });

  const history = [{ role: "user", parts: [{ text: "x" }] }];
  const result = await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: vault },
    callbacks: {},
  });

  assert.equal(result.totalUsage.promptTokenCount, 300);
  assert.equal(result.totalUsage.candidatesTokenCount, 75);
  assert.equal(result.totalUsage.cachedContentTokenCount, 50);
  // Issue #31: peakUsage.promptTokenCount is the LAST iteration's count
  // (200), not the cumulative sum (300). Each iteration's prompt count
  // already includes the full history at that call, so summing overcounts.
  // Provider uses peak for `contextTokens`; total stays for billing.
  assert.equal(result.peakUsage.promptTokenCount, 200,
    "peakUsage.promptTokenCount must equal the LAST iteration's count, not the sum");
});

// ---------- max-iterations safety rail ----------

test("loop: exceeds MAX_ITERATIONS → onError fires, returns gracefully", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "loop.txt"), "x");

  const client = new MockClient();
  for (let i = 0; i < MAX_ITERATIONS + 5; i++) {
    client.queueResponse(functionCallTurn("Read", { file_path: "loop.txt" }, `c-${i}`));
  }

  const errors = [];
  const result = await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys",
    history: [{ role: "user", parts: [{ text: "loop" }] }],
    ctx: { vaultRoot: vault },
    callbacks: { onError: (m) => errors.push(m) },
  });

  assert.equal(result.iterations, MAX_ITERATIONS);
  assert.ok(errors.some((e) => /exceeded.*iterations/i.test(e)));
});

// ---------- finish-reason diagnostic ----------

test("loop: non-STOP finishReason without tool calls surfaces as onError diagnostic", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      textChunk("partial response cut off", "MAX_TOKENS"),
    ],
  });

  const errors = [];
  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys",
    history: [{ role: "user", parts: [{ text: "x" }] }],
    ctx: { vaultRoot: tmpVault() },
    callbacks: { onError: (m) => errors.push(m) },
  });

  assert.ok(errors.some((e) => /MAX_TOKENS/.test(e)),
    "finishReason should surface as diagnostic onError");
});

// ---------- F24-1 regression: empty-parts model turn must not poison history ----------

test("F24-1 — SAFETY-blocked turn (no text, no functionCalls) does NOT push empty-parts model turn to history", async () => {
  const client = new MockClient();
  // Iteration 1: chunk with finishReason="SAFETY" but no parts
  client.queueResponse({
    chunks: [
      {
        candidates: [{
          content: { parts: [] },
          finishReason: "SAFETY",
        }],
      },
    ],
  });

  const errors = [];
  const history = [{ role: "user", parts: [{ text: "blocked prompt" }] }];
  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: { onError: (m) => errors.push(m) },
  });

  // Critical: history must NOT contain a `{ role: "model", parts: [] }` entry.
  // Gemini rejects that on the next request with INVALID_ARGUMENT 400.
  for (const turn of history) {
    if (turn.role === "model") {
      assert.ok(turn.parts.length > 0,
        `model turn with empty parts found — would 400 the next send: ${JSON.stringify(turn)}`);
    }
  }
  // SAFETY diagnostic must surface via onError.
  assert.ok(errors.some((e) => /SAFETY/.test(e)),
    "SAFETY finishReason must be reported via onError");
});

test("F24-1 — empty turn followed by a successful send doesn't trip Gemini (history stays valid)", async () => {
  // First turn: SAFETY block (empty), second turn: normal text response.
  // The combined history sent on the second turn must not contain the
  // empty-parts model entry.
  const client = new MockClient();
  client.queueResponse({
    chunks: [{ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }],
  });
  client.queueResponse({
    chunks: [textChunk("here we go", "STOP")],
  });

  const history = [{ role: "user", parts: [{ text: "first prompt" }] }];

  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });

  // Simulate the user sending a follow-up — caller pushes user, then loop runs.
  history.push({ role: "user", parts: [{ text: "second prompt" }] });

  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });

  // Inspect the contents the SECOND call sent to Gemini — must NOT include
  // an empty-parts model turn.
  const secondCallContents = client.calls[1].contents;
  for (const c of secondCallContents) {
    if (c.role === "model") {
      assert.ok(c.parts.length > 0,
        `Second send contained empty-parts model turn: ${JSON.stringify(c)}`);
    }
  }
});

// ---------- registry routing smoke ----------

test("loop: unknown tool name reaches tool-registry's executeTool (proves no bypass)", async () => {
  const client = new MockClient();
  client.queueResponse(functionCallTurn("RootKit", {}, "c-evil"));
  client.queueResponse({ chunks: [textChunk("ack", "STOP")] });

  const history = [{ role: "user", parts: [{ text: "hack" }] }];
  await runGeminiToolLoop({
    client, model: "gemini-2.5-pro", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });

  const toolMsg = history.find((c) => c.role === "user" && c.parts[0] && c.parts[0].functionResponse);
  assert.ok(toolMsg);
  // Tool registry returns isError=true → serializer puts the body
  // in `result` and signals failure via `success: false`. (Field
  // was previously named `error`; renamed to keep Gemini's model
  // from prepending "Error: " when echoing the content.)
  const fr = toolMsg.parts[0].functionResponse.response;
  assert.strictEqual(fr.success, false);
  assert.match(fr.result || "", /Unknown tool/);
  assert.match(fr.result || "", /RootKit/);
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});
