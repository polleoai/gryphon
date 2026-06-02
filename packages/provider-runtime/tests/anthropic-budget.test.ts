/**
 * Task 4.2 — Anthropic provider aborts mid-loop when maxUsdBudget exceeded.
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

// Stub the Anthropic SDK before requiring the provider.
class FakeAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = {
      countTokens: async () => { throw new Error("not stubbed"); },
      stream: () => { throw new Error("stream not stubbed — override on instance"); },
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
const { BudgetExceededError } = require("../src/budget-error");

// Build a mock stream that returns a high token-count response (1M input tokens
// at $3/M = $3 per turn, which blows any budget < $3).
// stop_reason="end_turn" means no tool loop — just one turn.
function makeMockStream({ content, stop_reason, usage }) {
  const handlers = {};
  return {
    on(event, fn) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(fn);
      return this;
    },
    async finalMessage() {
      return { id: "msg_mock", content, stop_reason, usage };
    },
  };
}

test("Anthropic provider aborts mid-loop when maxUsdBudget exceeded", async () => {
  const provider = new AnthropicAPIProvider("test-key", "/vault");

  // 1M input tokens at $3/M (Sonnet pricing) = $3 per turn.
  // maxUsdBudget is $1.00 — one turn should trip the budget.
  const highCostUsage = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  provider.client.messages.stream = () => makeMockStream({
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: highCostUsage,
  });

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

test("Anthropic provider: send without maxUsdBudget works normally", async () => {
  const provider = new AnthropicAPIProvider("test-key", "/vault");

  const normalUsage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  provider.client.messages.stream = () => makeMockStream({
    content: [{ type: "text", text: "Normal response" }],
    stop_reason: "end_turn",
    usage: normalUsage,
  });

  const result = await provider.send("hi");
  assert.equal(result.text, "Normal response");
  assert.ok(result.cost >= 0);
});
