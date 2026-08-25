// Poll an observation until it matches, or until a declared budget runs out. The MECHANISM behind
// every retrying assertion in this package, owned here so a second one cannot arrive with its own
// deadline, its own interval and its own idea of what to report — the rule `backoff.ts` already
// holds for retries that back off.

import { assert } from '@ultimat3/core';

/**
 * What a retrying assertion is allowed to spend. A FIXED interval and not a curve: an assertion
 * about a page is asked "is it there yet", and doubling the gap makes the last look land long
 * after the state changed — the caller's deadline is the contract, and a curve would quietly
 * spend most of it waiting. There is exactly one backoff curve in this framework
 * (`@ultimat3/core`'s `backoff.ts`) and this is deliberately not a second one.
 */
export interface RetryBudget {
  /** Total time the assertion may wait, in milliseconds. `0` is one look and no wait. */
  readonly timeout: number;
  /** Gap between looks, in milliseconds. */
  readonly interval: number;
}

export interface RetryOutcome<T> {
  readonly matched: boolean;
  /** How many times the observation ran. `attemptsFor(budget)` when it never matched. */
  readonly attempts: number;
  /** What the last look answered — what a failure message reports as "saw" instead. */
  readonly last: T;
}

/** Playwright's own default, which is what a reader of `toBeVisible()` already expects. */
export const DEFAULT_RETRY_BUDGET: RetryBudget = { timeout: 5_000, interval: 100 };

/**
 * How many times the observation will run at most: one free look, plus one per whole interval in
 * the budget. Exported because it is what makes a retry TESTABLE — a test asserts this number
 * rather than measuring elapsed time, which is the one thing a frozen clock cannot give it.
 */
export const attemptsFor = (budget: RetryBudget): number =>
  1 + Math.floor(budget.timeout / budget.interval);

/** Real time passes here and nowhere else in this module, which is what makes `sleep` injectable. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Look, test, sleep, repeat — stopping on the look that matches or on the last one the budget buys.
 *
 * `sleep` is a DEFAULT PARAMETER and not a module-level call, the same seam a `random = Math.random`
 * default is: a test injects a counting stub and asserts how many times this slept and how many
 * times it looked, so "it retried, and it stopped when it said it would" is a measurement rather
 * than a wall-clock hope. This package freezes `Date.now()`, so a deadline computed from the clock
 * would never expire and the loop would spin forever — the budget is counted in LOOKS for that
 * reason, not in elapsed milliseconds.
 *
 * Never sleeps after the look that answered: a passing assertion costs one observation and no time
 * at all, which is what keeps a retrying matcher usable in a suite of hundreds.
 */
export const retryUntil = async <T>(
  observe: () => Promise<T>,
  matches: (value: T) => boolean,
  budget: RetryBudget = DEFAULT_RETRY_BUDGET,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<RetryOutcome<T>> => {
  // Refused rather than attempted: a zero or negative interval is an unbounded spin, and the
  // failure mode is a test that never fails — it hangs, and CI reports a runner timeout with no
  // assertion anywhere in it.
  assert(
    Number.isFinite(budget.interval) && budget.interval > 0,
    `a retry interval must be a positive number of milliseconds, got ${String(budget.interval)}`,
    'toBeVisible({ interval: 100 })   # the gap between looks; the default budget is 5000ms every 100ms',
  );
  assert(
    Number.isFinite(budget.timeout) && budget.timeout >= 0,
    `a retry timeout must be zero or more milliseconds, got ${String(budget.timeout)}`,
    'toBeVisible({ timeout: 5000 })   # the whole wait; 0 is one look and no wait',
  );
  const limit = attemptsFor(budget);
  let attempts = 0;
  let last = await observe();
  attempts += 1;
  while (!matches(last) && attempts < limit) {
    await sleep(budget.interval);
    last = await observe();
    attempts += 1;
  }
  return { matched: matches(last), attempts, last };
};
