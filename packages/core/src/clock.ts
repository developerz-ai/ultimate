// Single responsibility: the only source of "now" in the framework, and the clock types. Everything
// time-related takes a `Clock` (or a `SleepClock` when it waits) so tests freeze time instead of
// sleeping. Nothing else may call `Date.now()`. Page-safe: what waits is `sleep-clock.ts`, server-only.

import { adapterSlot } from './adapter-slot';
import { finiteOption } from './finite-option';

export interface Clock {
  /** Wall-clock instant. Always UTC-backed; format at the edge with an explicit IANA tz. */
  now(): Date;
  /** Monotonic milliseconds — safe for durations, unaffected by wall-clock jumps. */
  monotonic(): number;
}

/**
 * A clock that can also wait. ONE type for every wait in the framework — it replaced
 * `@ultimat3/scraping`'s `ScrapeClock` and `@ultimat3/cli`'s `ShotClock`, which were this
 * interface twice under two names.
 */
export interface SleepClock extends Clock {
  /**
   * Resolve after `ms` of this clock's time, or reject with the signal's reason — VERBATIM, never
   * wrapped: whoever aborted put an `UltimateError` with a fix there — the moment it aborts.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface FrozenClock extends SleepClock {
  /** Move wall-clock and monotonic time forward by `ms`. */
  advance(ms: number): void;
  set(at: Date | number | string): void;
}

/**
 * Now and monotonic, nothing else. This is the object `./page` ships to the browser, so it carries
 * no `sleep`: no client caller waits on a clock, and the bytes would ride every route (axiom 6).
 * Waiting code reads `ambientClock()` (`sleep-clock.ts`), whose default is the system `SleepClock`
 * with these same `now`/`monotonic`, exported as `systemClock` from `./adapter` only.
 */
export const systemClock: Clock = Object.freeze({
  now(): Date {
    return new Date();
  },
  monotonic(): number {
    return performance.now();
  },
});

/**
 * The `clock` adapter port's frames. Here, not in `sleep-clock.ts`, so a NOW reader (`liveClock`)
 * follows `installClock` without a browser bundle paying for `sleep`. Pure, so a bundle that never
 * reads `liveClock` keeps none of it.
 */
export const installedClocks = /* @__PURE__ */ adapterSlot<SleepClock | undefined>(() => undefined);

/**
 * "Now", as the `clock` port says: the installed clock's `now`/`monotonic`, read at EACH call, or the
 * system's. The default of the server's readers of the present — `ctxOf` (so every action, query,
 * job and `uuidV7(ctx.clock)`) and the logger — so `runtime.ts`'s `clock` and a test's
 * `installClock` reach them. `systemClock` stays the default where that is the point: deadlines and
 * backoff that race REAL timers (`retry-loop`, `breaker`, `outbound`, the drain; a frozen clock under
 * a real `setTimeout` is a budget that never spends), AWS signing, and a bare `uuidV7()` — it ships
 * on `./page`, where nothing installs a clock and the slot would be bytes that buy nothing.
 */
export const liveClock: Clock = /* @__PURE__ */ Object.freeze({
  now: (): Date => (installedClocks.current() ?? systemClock).now(),
  monotonic: (): number => (installedClocks.current() ?? systemClock).monotonic(),
});

function toEpochMs(at: Date | number | string): number {
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  return new Date(at).getTime();
}

/**
 * A clock stuck at `at` until `advance()` is called. Monotonic starts at 0. Sleeping IS advancing:
 * `await clock.sleep(30_000)` returns on the next microtask with thirty seconds elapsed, so a
 * poll-until-deadline test is instant without knowing how many polls the loop makes.
 */
export function frozenClock(at: Date | number | string = 0): FrozenClock {
  let epochMs = toEpochMs(at);
  let mono = 0;
  const advance = (ms: number): void => {
    epochMs += ms;
    mono += ms;
  };
  return {
    now: () => new Date(epochMs),
    monotonic: () => mono,
    advance,
    set(next: Date | number | string): void {
      epochMs = toEpochMs(next);
    },
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      // Screened: `epochMs += NaN` is a clock no later `set` can trust again.
      const wait = finiteOption('frozenClock.sleep', 'ms', ms);
      signal?.throwIfAborted();
      advance(Math.max(0, wait));
      // Yield anyway: a loop that never awaits anything real starves whatever armed its abort.
      await Promise.resolve();
      signal?.throwIfAborted();
    },
  };
}
