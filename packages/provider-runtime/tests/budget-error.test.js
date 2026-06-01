const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BudgetExceededError } = require("../src/budget-error");
const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");

test("BudgetExceededError carries budget, spent, lastTurnCost", () => {
  const e = new BudgetExceededError({ budget: 0.50, spent: 0.62, lastTurnCost: 0.15 });
  assert.equal(e.name, "BudgetExceededError");
  assert.equal(e.budget, 0.50);
  assert.equal(e.spent, 0.62);
  assert.equal(e.lastTurnCost, 0.15);
  assert.match(e.message, /budget.*0\.50/);
  assert.match(e.message, /spent.*0\.62/);
});

test("BudgetExceededError instanceof Error", () => {
  const e = new BudgetExceededError({ budget: 1, spent: 2, lastTurnCost: 1 });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof BudgetExceededError);
});

test("send() throws RangeError synchronously on non-positive maxUsdBudget", async () => {
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.resolve({ text: "x", sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0 }),
  });
  for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity]) {
    let err = null;
    try { await provider.send("p", { maxUsdBudget: bad }); } catch (e) { err = e; }
    assert.ok(err instanceof RangeError, `expected RangeError for ${bad}, got ${err && err.name}`);
  }
});
