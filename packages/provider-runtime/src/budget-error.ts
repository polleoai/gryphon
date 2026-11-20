/**
 * BudgetExceededError — thrown by providers when cumulative USD cost
 * for a single send() call exceeds the consumer-supplied maxUsdBudget cap.
 *
 * SDK providers throw mid-loop (after each model response). CLI providers
 * throw post-turn (subprocess owns its internal loop; cannot abort mid-stream).
 *
 * Issue #53: the cap fails CLOSED. When a budgeted call's cost can't be read
 * (missing, non-numeric, non-finite or negative), the call is stopped with
 * this same error and `costUnknown: true`; an unknown cost never counts as
 * $0. `spent` is then the part of the spend that WAS measured.
 *
 * Per L5 in docs/consumer-requirements.md.
 */

class BudgetExceededError extends Error {
  declare budget: number;
  declare spent: number;
  declare lastTurnCost: number;
  declare costUnknown: boolean;
  constructor({ budget, spent, lastTurnCost, costUnknown = false }: { budget: number; spent: number; lastTurnCost: number; costUnknown?: boolean }) {
    super(costUnknown
      ? `Per-call budget can't be verified: the provider didn't report this call's cost (budget=$${budget.toFixed(2)}). Stopped so the budget can't be exceeded unseen.`
      : `Per-call budget exceeded: budget=$${budget.toFixed(2)}, spent=$${spent.toFixed(2)}`);
    this.name = "BudgetExceededError";
    this.budget = budget;
    this.spent = spent;
    this.lastTurnCost = lastTurnCost;
    this.costUnknown = costUnknown;
  }
}

export { BudgetExceededError };