/**
 * One round's turn allowance, carried as a single mutable object rather than as a
 * number threaded down and a count threaded back up.
 *
 * The distinction matters because a round is not one model call. It is a
 * primary→fallback pair, and the fallback *restarts* the round from the same
 * messages — so a failed primary is work redone, with whatever tool side effects
 * it already had. Both attempts spend the same allowance. When that allowance was
 * a plain number, keeping the second attempt honest meant remembering to decrement
 * it between the two, and forgetting let one round cost twice its budget. Sharing
 * one object removes the thing there was to forget.
 *
 * `spent` is mutated where the turn is actually spent (the model loop's
 * `onStepEnd`) and read where it actually matters (the RPC return that the
 * Workflow meters against the Task). Nothing in between carries it.
 */

/** One round's allowance and what it has spent, across every attempt in the round. */
export interface TurnBudget {
  /** What this round was allowed when it started: the Task's unspent turns. */
  readonly allowance: number;
  /** Turns spent so far. Mutated by the model loop, one per completed step. */
  spent: number;
}

/** A fresh budget for a round that may spend `allowance` turns. */
export const newTurnBudget = (allowance: number): TurnBudget => ({
  allowance,
  spent: 0
});

/**
 * Steps one `generateText` attempt may spend, given what the run has already used.
 *
 * Must be evaluated **per attempt**: `isStepCount` counts steps within a single
 * call, so an allowance computed once and shared with the fallback would hand it
 * the turns the primary already burned.
 *
 * The `Math.max(1, …)` floor is load-bearing, not defensive. A primary that
 * consumed the entire remainder still leaves the fallback one step, because an
 * attempt with nothing to spend cannot reach an ending — which fails the round and
 * costs the caller its answer, a far worse trade than one turn. So a round may
 * exceed its allowance by exactly one, and never by more.
 */
export const stepAllowance = (maxTurns: number, spent: number): number =>
  Math.max(1, maxTurns - spent);
