// Elapsed-time budgets for every wait a scraper does — the actionability poll, the wedge watchdog,
// the rate limiter, the graceful-quit ceiling. The waiting itself is `@ultimat3/core`'s `SleepClock`
// (`ambientClock()` unless a definition pins one), so a suite that exercises a 30-second timeout
// finishes in microseconds. `clock-discipline.test.ts` fails the build if a file here arms a timer.

import type { Clock } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';

/** Elapsed-time budget, read from one clock. Built once per waiting call, never shared. */
export interface Deadline {
  readonly totalMs: number;
  remainingMs(): number;
  expired(): boolean;
}

export function deadline(clock: Clock, totalMs: number, subject = 'a scrape wait'): Deadline {
  // Screened HERE because this is the one constructor of a budget, and every `for (;;)` in this
  // package asks `expired()` to leave it. `Math.max(0, NaN - elapsed)` is `NaN` and `NaN <= 0` is
  // false, so a budget that is not a number never expires: the loop in `awaitActionable` and the
  // one in `page-over-target.ts`'s `frame()` both become unbounded, re-reading a live browser once
  // per `Math.min(pollMs, NaN)` — which is `NaN`, which `setTimeout` reads as 0.
  const budgetMs = finiteCount(subject, 'timeoutMs', totalMs);
  const startedAt = clock.monotonic();
  const remainingMs = (): number => Math.max(0, budgetMs - (clock.monotonic() - startedAt));
  return { totalMs: budgetMs, remainingMs, expired: () => remainingMs() <= 0 };
}
