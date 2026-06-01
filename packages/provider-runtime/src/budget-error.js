/**
 * BudgetExceededError — thrown by providers when cumulative USD cost
 * for a single send() call exceeds the consumer-supplied maxUsdBudget cap.
 *
 * SDK providers throw mid-loop (after each model response). CLI providers
 * throw post-turn (subprocess owns its internal loop; cannot abort mid-stream).
 *
 * Per L5 in docs/consumer-requirements.md.
 */

class BudgetExceededError extends Error {
  constructor({ budget, spent, lastTurnCost }) {
    super(`Per-call budget exceeded: budget=$${budget.toFixed(2)}, spent=$${spent.toFixed(2)}`);
    this.name = "BudgetExceededError";
    this.budget = budget;
    this.spent = spent;
    this.lastTurnCost = lastTurnCost;
  }
}

module.exports = { BudgetExceededError };
