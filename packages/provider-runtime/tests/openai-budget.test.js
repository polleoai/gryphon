/**
 * Task 4.3 — OpenAI provider aborts mid-loop when maxUsdBudget exceeded.
 *
 * Validates:
 *   - send(prompt, { maxUsdBudget: 1.00 }) throws BudgetExceededError when
 *     the first turn's token cost exceeds the cap.
 *   - error.name === "BudgetExceededError"
 *   - error.spent >= maxUsdBudget
 *   - error.budget === maxUsdBudget
 *   - Backwards compat: send(prompt) without maxUsdBudget continues to work.
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
const { BudgetExceededError } = require("../src/budget-error");

// 1M prompt tokens at gpt-5.4-mini pricing:
// gpt-5.4-mini input: $0.15/M → $0.15 per turn at 1M tokens.
// We need a bigger number to exceed $1.00 — use 10M tokens (= $1.50).
// Or we can use gpt-4o at $5/M and 1M tokens = $5 which blows $1.00.
// The provider's resolvedModel uses coerceToVendorModel('gpt-4o') = 'gpt-4o'
// (if it's in the supported list). Let's use a large token count that
// will exceed $1 regardless of which model is resolved.
// gpt-5.4-mini at $0.15/M: need >6.67M tokens. Use 10M input tokens = $1.50.
const HIGH_COST_USAGE = {
  prompt_tokens: 10_000_000,  // $1.50 at gpt-5.4-mini input rate ($0.15/M)
  completion_tokens: 0,
  prompt_tokens_details: { cached_tokens: 0 },
};

test("OpenAI provider aborts mid-loop when maxUsdBudget exceeded", async () => {
  const client = new MockClient();
  // Queue a high-cost response
  client.queueResponse({
    chunks: ["Hello"],
    completion: {
      id: "chatcmpl-budget-test",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: HIGH_COST_USAGE,
    },
  });

  const provider = new OpenAIProvider("sk-test", "/vault", { client });

  let caughtError = null;
  try {
    await provider.send("hi", { maxUsdBudget: 1.00 });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError !== null, "should have thrown");
  assert.equal(caughtError.name, "BudgetExceededError");
  assert.ok(caughtError instanceof BudgetExceededError);
  assert.ok(caughtError instanceof Error);
  assert.equal(caughtError.budget, 1.00);
  assert.ok(caughtError.spent >= 1.00, `spent=${caughtError.spent} should be >= 1.00`);
});

test("OpenAI provider: send without maxUsdBudget works normally", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: ["Normal response"],
    completion: {
      id: "chatcmpl-normal",
      choices: [{ index: 0, message: { role: "assistant", content: "Normal response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
    },
  });

  const provider = new OpenAIProvider("sk-test", "/vault", { client });
  const result = await provider.send("hi");
  assert.equal(result.text, "Normal response");
  assert.ok(result.cost >= 0);
});
