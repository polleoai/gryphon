/**
 * Shared maxUsdBudget checks (issue #53: fail closed on unknown cost).
 *
 * A cost is KNOWN only when it is a finite, non-negative number. Anything
 * else — missing, NaN, a string, negative, or a result flagged
 * `costUnknown` — is unknown, and stops a budgeted call.
 */
declare function isKnownCost(n: unknown): n is number;
interface CostResult {
    cost?: unknown;
    cumulativeCost?: unknown;
    costUnknown?: boolean;
}
/** True when this turn's result carries a usable session-cumulative cost. */
declare function resultCostKnown(r: CostResult | null | undefined): boolean;
/**
 * The session total to carry forward after a turn: the turn's reported
 * cumulative cost when known, otherwise the previous total (an unknown turn
 * must never reset the running total to 0).
 */
declare function nextCumulative(prev: number, r: CostResult | null | undefined): number;
type Notify = ((msg: string, opts?: {
    level?: string;
}) => void) | null | undefined;
/**
 * CLI post-turn budget check. `callSpentBefore` is what earlier turns of
 * this same send() (structured-output retries) already spent; 0 for the
 * first turn. Returns the call's spend so far.
 *
 * The call's spend is the SUM OF ITS OWN TURN COSTS — never "session total
 * now minus session total before": a CLI's session counter restarts at 0
 * when its process is replaced (abort, crash, supersede), which made that
 * delta read low or negative and let an over-budget call through.
 *
 * Throws BudgetExceededError when the spend reaches the budget, or
 * (costUnknown) when this turn's cost can't be read — missing, non-finite
 * or negative (a negative turn cost can only come from a counter reset).
 */
declare function checkCliBudget(budget: number, callSpentBefore: number, r: CostResult, notify?: Notify): number;
/**
 * True when an API usage block carries the field the vendor always reports
 * for a billed response (the input token count). Missing usage, or usage
 * without that field, is unknown cost.
 */
declare function usageKnown(usage: unknown, field: string): boolean;
export { isKnownCost, resultCostKnown, nextCumulative, checkCliBudget, usageKnown };
