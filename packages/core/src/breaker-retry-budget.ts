// Single responsibility: the retry token ratio per breaker key — retries at most a fifth of calls,
// so a fleet retrying a partially failing vendor cannot multiply its load by the attempt count.
// The breaker cannot see that outage (no run of CONSECUTIVE failures); the attempt clamp is per call.

import type { Breaker } from './breaker';

/** Whole units, never a fractional token: a call earns 1, a retry costs 5 — the 20% ratio. */
const CALL_CREDIT = 1;
const RETRY_COST = 5;

/** Retries a quiet key may spend before calls earn any back: a low-traffic caller still retries. */
export const RETRY_BURST = 10;
const BANK_CAP = RETRY_BURST * RETRY_COST;

export interface RetryBudget {
  /** One call went out: earns a fifth of a retry, up to the burst. */
  called(): void;
  /** May one more retry go out: spends it when yes. */
  spend(): boolean;
}

/**
 * By breaker identity: the breaker IS the key (`name` is a label two breakers may share), and a
 * breaker dropped by its owner takes its budget with it. Per process, as the breaker is.
 */
const budgets = new WeakMap<Breaker, RetryBudget>();

function retryBudget(): RetryBudget {
  let bank = BANK_CAP;
  return {
    called() {
      bank = Math.min(BANK_CAP, bank + CALL_CREDIT);
    },
    spend() {
      if (bank < RETRY_COST) return false;
      bank -= RETRY_COST;
      return true;
    },
  };
}

export function retryBudgetOf(gate: Breaker): RetryBudget {
  const known = budgets.get(gate);
  if (known !== undefined) return known;
  const made = retryBudget();
  budgets.set(gate, made);
  return made;
}
