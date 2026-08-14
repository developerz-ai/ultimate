// The `rate` throttle a `backfill()` sweeps under: batches per second, spent as a wait between one
// batch and the next. A sweep shares its connection pool with the requests the app is still
// serving, so a backfill that runs flat out is an outage of its own making — the pacer is what
// makes "one pass over the table" background work rather than a load test.

import type { Clock } from '@ultimat3/core';
import { assert, systemClock } from '@ultimat3/core';
import { nowMs } from './clock';
import { JobAbortedError } from './errors';

/**
 * Batches per second, and deliberately slow: at `DEFAULT_BACKFILL_BATCH` (1,000 rows) this is
 * 5,000 rows/sec — one statement every 200ms, so the pool spends the other 199 serving the app,
 * and a million-row table is still swept in under four minutes. A sweep that has to go faster
 * raises the number; there is no unthrottled mode to reach for instead.
 */
export const DEFAULT_BACKFILL_RATE = 5;

/**
 * Under a millisecond there is no timer to wait on — `setTimeout(0.4)` fires a millisecond later,
 * which would leave the pass SLOWER than the rate it declared. So a rate far above what the
 * batches can actually achieve degenerates to no wait at all, which is the point: to sweep faster
 * you raise `rate`, never turn the pacer off.
 */
const RESOLUTION_MS = 1;

export interface PacerOptions {
  /**
   * Batches per second, greater than zero and finite. `backfill()` refuses a bad one at the
   * declaration, where it was written and with the definition's name in the message; this is the
   * same rule at the constructor, for the callers that do not come through a declaration.
   */
  readonly rate: number;
  /** The name a cancellation is reported under — one pacer belongs to exactly one backfill. */
  readonly job: string;
  readonly clock?: Clock | undefined;
  /**
   * The wait itself, injectable for the same reason the clock is: a test asserts what was ASKED
   * for instead of spending it. Must settle when `signal` aborts rather than waiting the rest out.
   */
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface Pacer {
  /** Batches per second this pacer was built for. */
  readonly rate: number;
  /**
   * Hold the caller until this batch's slot comes round. Rejects with `JobAbortedError` when the
   * attempt was cancelled — before the wait or during it, never after sitting the timer out.
   */
  wait(args: { readonly signal: AbortSignal; readonly step?: string | undefined }): Promise<void>;
}

/** Real timers, cleared on abort so a cancelled pass leaves nothing pending behind it. */
function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Built once, at declaration, and shared by every attempt of that backfill in this process: the
 * rate is a property of the table being swept and the pool it is swept through, not of whichever
 * attempt happens to hold the run.
 */
export function createPacer(options: PacerOptions): Pacer {
  // Refused HERE and not only at `backfill()`: `rate: 0` makes `intervalMs` Infinity, which the
  // timer clamps to about a millisecond — so an unvalidated zero reads as "no throttle at all",
  // which is the one setting this module exists to make unreachable. A negative rate is the same
  // bug with a negative wait.
  assert(
    Number.isFinite(options.rate) && options.rate > 0,
    `createPacer({ rate: ${String(options.rate)} }) for "${options.job}" — a rate is batches per second, greater than zero`,
    `pass rate: ${DEFAULT_BACKFILL_RATE} — to sweep faster raise the number, there is no unthrottled mode`,
  );
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? timerSleep;
  const intervalMs = 1000 / options.rate;
  let lastAt: number | undefined;

  return {
    rate: options.rate,
    async wait({ signal, step }) {
      const aborted = (): JobAbortedError =>
        new JobAbortedError({ job: options.job, ...(step === undefined ? {} : { step }) });
      if (signal.aborted) throw aborted();

      const at = nowMs(clock);
      // The batch's own time is interval already paid, so a slow page waits for nothing and only a
      // fast one is held back. The first batch has no previous one to be spaced from.
      const remaining = lastAt === undefined ? 0 : intervalMs - (at - lastAt);
      if (remaining < RESOLUTION_MS) {
        lastAt = at;
        return;
      }
      await sleep(remaining, signal);
      // The sleeper settles early on abort, so what it means is "the wait is over", never "the
      // slot arrived" — the attempt no longer owns the run and must not read another page.
      if (signal.aborted) throw aborted();
      lastAt = nowMs(clock);
    },
  };
}
