/**
 * BudgetExceededError — thrown by providers when cumulative USD cost
 * for a single send() call exceeds the consumer-supplied maxUsdBudget cap.
 *
 * SDK providers throw mid-loop (after each model response). CLI providers
 * throw post-turn (subprocess owns its internal loop; cannot abort mid-stream).
 *
 * Per L5 in docs/consumer-requirements.md.
 */
export {};
