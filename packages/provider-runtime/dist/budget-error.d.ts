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
declare class BudgetExceededError extends Error {
    budget: number;
    spent: number;
    lastTurnCost: number;
    costUnknown: boolean;
    constructor({ budget, spent, lastTurnCost, costUnknown }: {
        budget: number;
        spent: number;
        lastTurnCost: number;
        costUnknown?: boolean;
    });
}
export { BudgetExceededError };
