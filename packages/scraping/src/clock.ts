// The ONE file in this package allowed to make time pass. Every wait a scraper does — the
// actionability poll, the wedge watchdog, the rate limiter, the graceful-quit ceiling — goes
// through `ScrapeClock`, so a suite that exercises a 30-second timeout finishes in microseconds.
//
// `clock-discipline.test.ts` fails the build if a second file reaches for a timer directly.

import type { Clock } from '@ultimat3/core';

export interface ScrapeClock extends Clock {
  /**
   * Resolve after `ms` of this clock's time, or reject with the signal's reason the moment it
   * aborts. Every poll loop here composes a wait with a cancellation, so a clock whose sleep
   * ignored the signal would leave a killed run still counting.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemScrapeClock: ScrapeClock = Object.freeze({
  now(): Date {
    return new Date();
  },
  monotonic(): number {
    return performance.now();
  },
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await Bun.sleep(ms);
      return;
    }
    throwIfAborted(signal);
    // A timer raced against the signal, never `Bun.sleep(ms).then(check)`: the watchdog aborts a
    // wedged run precisely so nothing waits out the rest of a five-minute budget, and a sleep
    // that only notices the abort when it expires would wait out every one of them.
    await new Promise<void>((resolve, reject) => {
      // The reason is rejected VERBATIM, never wrapped: whoever aborted put a `ScrapeError` with
      // a code and a fix there, and re-wrapping it would replace an instruction with `Error`.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  },
});

/** The abort reason, unwrapped — a caller's `AbortSignal.reason` is whatever they put there. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/**
 * A clock in which sleeping IS advancing: `await clock.sleep(30_000)` returns on the next
 * microtask with thirty seconds elapsed. This is what makes a poll-until-deadline test instant
 * without the test knowing how many polls the loop makes — a count a test that asserted it would
 * pin to the implementation rather than to the behaviour.
 */
export interface TestScrapeClock extends ScrapeClock {
  advance(ms: number): void;
}

export function testClock(at: Date | number = 0): TestScrapeClock {
  let epochMs = at instanceof Date ? at.getTime() : at;
  let mono = 0;
  const advance = (ms: number): void => {
    epochMs += ms;
    mono += ms;
  };
  return {
    now: () => new Date(epochMs),
    monotonic: () => mono,
    advance,
    sleep: async (ms: number, signal?: AbortSignal) => {
      advance(ms);
      // Yield the microtask queue anyway: a loop that never awaits anything real starves whatever
      // the test armed to cancel it, and the wedge tests arm exactly that.
      await Promise.resolve();
      if (signal !== undefined) throwIfAborted(signal);
    },
  };
}

/** Elapsed-time budget, read from one clock. Built once per waiting call, never shared. */
export interface Deadline {
  readonly totalMs: number;
  remainingMs(): number;
  expired(): boolean;
}

export function deadline(clock: Clock, totalMs: number): Deadline {
  const startedAt = clock.monotonic();
  const remainingMs = (): number => Math.max(0, totalMs - (clock.monotonic() - startedAt));
  return { totalMs, remainingMs, expired: () => remainingMs() <= 0 };
}
