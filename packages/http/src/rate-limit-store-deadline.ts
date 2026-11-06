// The shared rate-limit store's own deadline on one round trip. The pool's unanswered-statement
// bound (statement_timeout + 5 s) is sized for the app's work; a limiter that waits it out spends
// a request's whole budget deciding whether to admit it, then the request's own statement waits a
// second bound. Past this deadline the store degrades (`rate-limit-degrade.ts`) instead.

import { assert, finiteCount, MAX_TIMER_MS, type Scheduler } from '@ultimat3/core';
import { HttpError } from './errors';

/**
 * Measured 2026-11-06, Bun 1.3, Postgres 17 on loopback, `web` pool (max 20), three runs each: a
 * cold first statement (connect + SCRAM) 15–31 ms; a warm take p99 0.4 ms; 100 concurrent takes on
 * ONE hot key (row-lock queue) max 11.3 ms. 250 ms is ~8x the worst cold connect and ~20x the
 * worst contended take, and costs a blackholed request a quarter second instead of ~16 s.
 */
export const RATE_LIMIT_STORE_DEADLINE_MS = 250;

/** Unreffed: a deadline guards work in flight and must never keep a finished process alive. */
const unrefSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface StoreDeadline {
  /** `sending`'s answer, or `X_RATE_LIMIT_STORE_TIMEOUT` once `deadlineMs` passes first. */
  bound<T>(statement: 'take' | 'peek', sending: Promise<T>): Promise<T>;
}

export const rateLimitStoreTimeout = (statement: string, deadlineMs: number): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_STORE_TIMEOUT',
    cause: `the shared rate-limit store's ${statement} statement did not answer within ${String(deadlineMs)} ms, so this decision was taken from this pod's memory`,
    fix: 'x doctor --json   # names the database binding this pod cannot reach; a database that is slow rather than gone takes postgresRateLimitStore({ executor, deadlineMs }) raised in the boot that builds it',
    meta: { statement, deadlineMs },
  });

/**
 * The abandoned statement is not cancelled — the executor has no seam for it — and the pool's own
 * sweep still retires it at its bound; `Promise.race` keeps its late rejection handled meanwhile.
 */
export function storeDeadline(
  deadlineMs: number = RATE_LIMIT_STORE_DEADLINE_MS,
  schedule: Scheduler = unrefSchedule,
): StoreDeadline {
  finiteCount('postgresRateLimitStore', 'deadlineMs', deadlineMs, 1);
  assert(
    deadlineMs <= MAX_TIMER_MS,
    `postgresRateLimitStore deadlineMs is ${String(deadlineMs)}, past the longest delay a timer holds, so it would fire at once`,
    `postgresRateLimitStore({ executor, deadlineMs: ${String(RATE_LIMIT_STORE_DEADLINE_MS)} })   # or any whole number of ms up to ${String(MAX_TIMER_MS)}`,
  );
  return {
    bound<T>(statement: 'take' | 'peek', sending: Promise<T>): Promise<T> {
      let cancel: () => void = () => undefined;
      const late = new Promise<never>((_, reject) => {
        cancel = schedule(() => reject(rateLimitStoreTimeout(statement, deadlineMs)), deadlineMs);
      });
      return Promise.race([sending, late]).finally(() => cancel());
    },
  };
}
