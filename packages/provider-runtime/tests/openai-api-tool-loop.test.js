/**
 * Stage 2 (#17) OpenAI tool-loop multi-turn driver tests.
 *
 * Exercises the agentic loop:
 *   1. Model returns finish_reason="tool_calls" with one or more calls
 *   2. Loop dispatches each via executeTool() (Gryphon's shared registry)
 *   3. Tool results land in history as role="tool" with tool_call_id
 *   4. Loop iterates until finish_reason="stop"
 *
 * Plus error paths:
 *   - malformed JSON arguments → tool error message, no throw
 *   - max-iterations safety rail
 *   - serializeToolResultContent for is_error pass-through
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
  runOpenAIToolLoop,
  MAX_ITERATIONS,
  serializeToolResultContent,
} = require("../src/providers/openai-api/tool-loop");
const { MockClient } = require("./_stubs/openai-mock-client");

function chunkResp(text, finish_reason, tool_calls, usage) {
  return {
    chunks: text ? [text] : [],
    completion: {
      id: "mock",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text || null, tool_calls },
        finish_reason,
      }],
      usage: usage || { prompt_tokens: 1, completion_tokens: 1 },
    },
  };
}

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-openai-loop-"));
}

// ---------- serializeToolResultContent ----------

test("serializeToolResultContent: array-of-blocks → joined string", () => {
  const r = {
    content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
  };
  assert.equal(serializeToolResultContent(r), "Hello world");
});

test("serializeToolResultContent: is_error prepends [tool error] prefix", () => {
  const r = { content: [{ type: "text", text: "denied" }], isError: true };
  assert.equal(serializeToolResultContent(r), "[tool error] denied");
});

test("serializeToolResultContent: null/undefined → empty string", () => {
  assert.equal(serializeToolResultContent(null), "");
  assert.equal(serializeToolResultContent(undefined), "");
});

test("serializeToolResultContent: string content passes through", () => {
  assert.equal(serializeToolResultContent({ content: "hello" }), "hello");
});

// ---------- single-turn (no tool calls) ----------

test("loop: pure text response — single iteration, history grows by 1", async () => {
  const client = new MockClient();
  client.queueResponse(chunkResp("hello back", "stop"));

  const history = [{ role: "user", content: "hi" }];
  const result = await runOpenAIToolLoop({
    client,
    model: "gpt-4o-mini",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: tmpVault(), permissionMode: "default" },
    callbacks: {},
  });

  assert.equal(result.iterations, 1);
  assert.equal(result.turnText, "hello back");
  assert.equal(history.length, 2, "user + assistant");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].content, "hello back");
});

test("loop: system prompt is prepended to messages but not to history", async () => {
  const client = new MockClient();
  client.queueResponse(chunkResp("ok", "stop"));
  const history = [{ role: "user", content: "hi" }];
  await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "you are gryphon",
    history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });
  // The first call's params.messages should include the system prompt
  const params = client.calls[0];
  assert.equal(params.messages[0].role, "system");
  assert.equal(params.messages[0].content, "you are gryphon");
  // But history itself should not contain the system prompt
  assert.equal(history[0].role, "user");
});

// ---------- multi-turn tool use ----------

test("loop: tool_calls turn dispatches via executeTool, appends role=tool result, iterates", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "hello.txt"), "world");

  const client = new MockClient();
  // Iteration 1: assistant requests Read(hello.txt)
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "call_1",
    type: "function",
    function: { name: "Read", arguments: JSON.stringify({ file_path: "hello.txt" }) },
  }]));
  // Iteration 2: assistant returns final text
  client.queueResponse(chunkResp("the file says world", "stop"));

  const history = [{ role: "user", content: "read hello.txt" }];
  const toolNames = [];
  const result = await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default" },
    callbacks: {
      onTool: (name) => toolNames.push(name),
    },
  });

  assert.equal(result.iterations, 2);
  assert.deepEqual(toolNames, ["Read"]);
  // History after: user, assistant (tool_calls), tool, assistant (final)
  assert.equal(history.length, 4);
  assert.equal(history[1].role, "assistant");
  assert.ok(Array.isArray(history[1].tool_calls), "assistant turn must keep tool_calls");
  assert.equal(history[2].role, "tool");
  assert.equal(history[2].tool_call_id, "call_1");
  // Read tool returns the file content with line numbers
  assert.match(history[2].content, /world/);
  assert.equal(history[3].role, "assistant");
  assert.equal(history[3].content, "the file says world");
});

test("loop: malformed tool arguments JSON → tool error message, loop continues", async () => {
  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "call_bad",
    type: "function",
    function: { name: "Read", arguments: "{not json" },
  }]));
  client.queueResponse(chunkResp("ack", "stop"));

  const history = [{ role: "user", content: "do something" }];
  await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: tmpVault() },
    callbacks: {},
  });

  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result must be appended");
  assert.match(toolMsg.content, /not valid JSON/);
});

test("loop: unsupported tool type → synthesized tool error, loop continues", async () => {
  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "call_x",
    type: "code_interpreter",  // future type Gryphon doesn't wire up
  }]));
  client.queueResponse(chunkResp("ok", "stop"));

  const history = [{ role: "user", content: "x" }];
  await runOpenAIToolLoop({
    client, model: "gpt-4o", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() }, callbacks: {},
  });

  const toolMsg = history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /code_interpreter/);
  assert.match(toolMsg.content, /not supported/);
});

test("loop: parallel tool_calls in one turn dispatch in order", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "a.txt"), "AAA");
  fs.writeFileSync(path.join(vault, "b.txt"), "BBB");

  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [
    { id: "call_a", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "a.txt" }) } },
    { id: "call_b", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "b.txt" }) } },
  ]));
  client.queueResponse(chunkResp("done", "stop"));

  const history = [{ role: "user", content: "read both" }];
  const toolNames = [];
  await runOpenAIToolLoop({
    client, model: "gpt-4o", systemPrompt: "sys", history,
    ctx: { vaultRoot: vault },
    callbacks: { onTool: (n) => toolNames.push(n) },
  });

  assert.deepEqual(toolNames, ["Read", "Read"]);
  // history: user, assistant(2 tool_calls), tool(a), tool(b), assistant(final)
  assert.equal(history.length, 5);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, "call_a");
  assert.equal(toolMsgs[1].tool_call_id, "call_b");
  assert.match(toolMsgs[0].content, /AAA/);
  assert.match(toolMsgs[1].content, /BBB/);
});

// ---------- usage aggregation ----------

test("loop: prompt+completion tokens aggregate across iterations", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "x.txt"), "x");

  const client = new MockClient();
  client.queueResponse({
    chunks: [],
    completion: {
      id: "m1", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "x.txt" }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    },
  });
  client.queueResponse({
    chunks: ["done"],
    completion: {
      id: "m2", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 50 } },
    },
  });

  const history = [{ role: "user", content: "x" }];
  const result = await runOpenAIToolLoop({
    client, model: "gpt-4o", systemPrompt: "sys", history,
    ctx: { vaultRoot: vault }, callbacks: {},
  });

  assert.equal(result.totalUsage.prompt_tokens, 300);
  assert.equal(result.totalUsage.completion_tokens, 75);
  assert.equal(result.totalUsage.prompt_tokens_details.cached_tokens, 50);
  // Issue #31: peakUsage.prompt_tokens is the LAST iteration's count
  // (200), not the cumulative sum (300). Each iteration's prompt_tokens
  // already includes the full history at that call, so summing
  // overcounts. The provider uses peak for `contextTokens` and
  // total for cost/billing — verify the two are decoupled.
  assert.equal(result.peakUsage.prompt_tokens, 200,
    "peakUsage.prompt_tokens must equal the LAST iteration's prompt_tokens, not the sum");
});

// ---------- issue #32: deny notice must NOT erase prior iteration text ----------

test("loop (issue #32): iteration 2's text APPENDS to iteration 1's, not replace", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "x.txt"), "x");

  const client = new MockClient();
  // Iteration 1: model emits assistant prose AND a tool_call
  // (note: real OpenAI completions can't carry both content and
  // tool_calls in the same final message simultaneously, but the
  // streaming path delivers content deltas before the tool_calls,
  // so the chunks array emits the prose).
  client.queueResponse({
    chunks: ["summary."],
    completion: {
      id: "m1",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "summary.",
          tool_calls: [{
            id: "c1",
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "x.txt" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  });
  // Iteration 2: model quotes the (synthetic) deny copy
  client.queueResponse({
    chunks: ["The Gryphon plugin is blocking the deletion of `x.md`..."],
    completion: {
      id: "m2",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "The Gryphon plugin is blocking the deletion of `x.md`...",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    },
  });

  const seenSnapshots = [];
  const history = [{ role: "user", content: "summarize then delete" }];
  const result = await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault },
    callbacks: {
      onMessage: (text, type) => {
        if (type === "replace") seenSnapshots.push(text);
      },
    },
  });

  // The final turnText must contain BOTH iteration 1's prose AND
  // iteration 2's deny quote, separated by a blank line. Pre-fix,
  // this was just iteration 2's text — the user's view wiped the
  // summary the moment the deny landed.
  assert.match(result.turnText, /^summary\./,
    "issue #32: turnText must START with iteration 1's prose");
  assert.match(result.turnText, /The Gryphon plugin is blocking/,
    "issue #32: turnText must also contain iteration 2's deny copy");
  assert.match(result.turnText, /summary\.\n\nThe Gryphon plugin is blocking/,
    "issue #32: iterations must be separated by a blank line");

  // The streaming snapshots emitted to the chat-view must show
  // monotonic growth — the second-iteration snapshot must INCLUDE
  // iteration 1's prose, not replace it.
  const iter2Snapshots = seenSnapshots.filter((s) =>
    s.includes("The Gryphon plugin is blocking"),
  );
  assert.ok(iter2Snapshots.length > 0,
    "iteration 2 must have produced at least one streaming snapshot");
  for (const s of iter2Snapshots) {
    assert.ok(s.startsWith("summary."),
      `streaming snapshot during iteration 2 must preserve iteration 1's prose. Got: ${JSON.stringify(s.slice(0, 80))}`);
  }
});

// ---------- max-iterations safety rail ----------

test("loop: exceeds MAX_ITERATIONS → onError fires, returns gracefully", async () => {
  const vault = tmpVault();
  fs.writeFileSync(path.join(vault, "loop.txt"), "x");

  const client = new MockClient();
  // Queue an infinite tool_calls response — every iteration asks for the same tool
  for (let i = 0; i < MAX_ITERATIONS + 5; i++) {
    client.queueResponse(chunkResp(null, "tool_calls", [{
      id: `call_${i}`,
      type: "function",
      function: { name: "Read", arguments: JSON.stringify({ file_path: "loop.txt" }) },
    }]));
  }

  const errors = [];
  const result = await runOpenAIToolLoop({
    client, model: "gpt-4o", systemPrompt: "sys",
    history: [{ role: "user", content: "loop" }],
    ctx: { vaultRoot: vault },
    callbacks: { onError: (m) => errors.push(m) },
  });

  assert.equal(result.iterations, MAX_ITERATIONS);
  assert.ok(errors.some((e) => /exceeded.*iterations/i.test(e)),
    "should warn about iteration cap");
});

// ---------- attack-detector / executeTool integration smoke ----------

test("loop: executeTool is the dispatch point — Gryphon's existing security rails apply unchanged", async () => {
  // We don't re-test attack-detector here (it has its own suite). What we
  // verify is that the loop ROUTES through executeTool — proven by the
  // Read-tool tests above succeeding with real file IO. If the loop
  // bypassed executeTool, those tests would fail.
  //
  // This test additionally checks that an unknown tool name reaches
  // tool-registry.executeTool and gets the standard "Unknown tool" error
  // (which proves dispatch goes through the registry, not a bypass path).
  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "call_evil",
    type: "function",
    function: { name: "RootKit", arguments: "{}" },
  }]));
  client.queueResponse(chunkResp("ack", "stop"));

  const history = [{ role: "user", content: "hack" }];
  await runOpenAIToolLoop({
    client, model: "gpt-4o", systemPrompt: "sys", history,
    ctx: { vaultRoot: tmpVault() }, callbacks: {},
  });

  const toolMsg = history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /Unknown tool/);
  assert.match(toolMsg.content, /RootKit/);
});

// ---------- restore module resolver ----------

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});
