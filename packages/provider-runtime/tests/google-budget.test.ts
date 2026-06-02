/**
 * Task 4.4 — Google provider aborts mid-loop when maxUsdBudget exceeded.
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

const { GoogleProvider } = require("../src/providers/google-api/google-api");
const { MockClient, usageChunk } = require("./_stubs/gemini-mock-client");
const { BudgetExceededError } = require("../src/budget-error");

// gemini-2.5-flash input: $0.30/M tokens.
// 5M prompt tokens = $1.50, which exceeds the $1.00 budget.
const HIGH_COST_USAGE = {
  promptTokenCount: 5_000_000,
  candidatesTokenCount: 0,
  cachedContentTokenCount: 0,
};

function textWithUsageChunk(text, finishReason, usage) {
  return {
    candidates: [{
      content: { parts: [{ text }] },
      ...(finishReason ? { finishReason } : {}),
    }],
    usageMetadata: usage,
  };
}

test("Google provider aborts mid-loop when maxUsdBudget exceeded", async () => {
  const client = new MockClient();
  // Queue a single high-cost response with embedded usage
  client.queueResponse({
    chunks: [textWithUsageChunk("Hello", "STOP", HIGH_COST_USAGE)],
  });

  const provider = new GoogleProvider("test-key", "/vault", { client });

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

test("Google provider: send without maxUsdBudget works normally", async () => {
  const client = new MockClient();
  client.queueResponse({
    chunks: [
      {
        candidates: [{ content: { parts: [{ text: "Normal response" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 0 },
      },
    ],
  });

  const provider = new GoogleProvider("test-key", "/vault", { client });
  const result = await provider.send("hi");
  assert.equal(result.text, "Normal response");
  assert.ok(result.cost >= 0);
});
