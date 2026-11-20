/**
 * Shared maxUsdBudget checks (issue #53: fail closed on unknown cost).
 *
 * A cost is KNOWN only when it is a finite, non-negative number. Anything
 * else — missing, NaN, a string, negative, or a result flagged
 * `costUnknown` — is unknown, and stops a budgeted call.
 */

import { BudgetExceededError } from "./budget-error";

function isKnownCost(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

interface CostResult {
  cost?: unknown;
  cumulativeCost?: unknown;
  costUnknown?: boolean;
}

/** True when this turn's result carries a usable session-cumulative cost. */
function resultCostKnown(r: CostResult | null | undefined): boolean {
  return !!r && !r.costUnknown && isKnownCost(r.cumulativeCost);
}

/**
 * The session total to carry forward after a turn: the turn's reported
 * cumulative cost when known, otherwise the previous total (an unknown turn
 * must never reset the running total to 0).
 */
function nextCumulative(prev: number, r: CostResult | null | undefined): number {
  return resultCostKnown(r) ? (r!.cumulativeCost as number) : prev;
}

type Notify = ((msg: string, opts?: { level?: string }) => void) | null | undefined;

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
function checkCliBudget(budget: number, callSpentBefore: number, r: CostResult, notify?: Notify): number {
  if (!resultCostKnown(r) || !isKnownCost(r.cost)) {
    if (notify) {
      try { notify("[gryphon] CLI provider did not report this call's cost; stopping the budgeted call", { level: "warn" }); }
      catch { /* notify must not block the guard */ }
    }
    throw new BudgetExceededError({ budget, spent: callSpentBefore, lastTurnCost: 0, costUnknown: true });
  }
  const spent = callSpentBefore + r.cost;
  if (spent >= budget) {
    throw new BudgetExceededError({ budget, spent, lastTurnCost: r.cost });
  }
  return spent;
}

/**
 * True when an API usage block carries the field the vendor always reports
 * for a billed response (the input token count). Missing usage, or usage
 * without that field, is unknown cost.
 */
function usageKnown(usage: unknown, field: string): boolean {
  if (!usage || typeof usage !== "object") return false;
  return isKnownCost((usage as Record<string, unknown>)[field]);
}

export { isKnownCost, resultCostKnown, nextCumulative, checkCliBudget, usageKnown };
