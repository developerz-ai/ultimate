// Single responsibility: the clock that WAITS — the server's `systemClock` with `sleep`, the test
// clock that waits one loop turn, and `ambientClock()`/`installClock` over the `clock` port's
// frames (`clock.ts`). Server-only: `./page` never imports this module, so no route pays for a timer
// nothing in the browser arms.

import type { SleepClock } from './clock';
import { installedClocks, systemClock as wallClock } from './clock';

/**
 * A timer raced against the signal, never `Bun.sleep(ms).then(check)`: a watchdog aborts a wedged
 * run precisely so nothing waits out the rest of its budget. An already-aborted signal throws inside
 * the executor, which rejects with its reason without arming a timer.
 */
function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The system clock that can wait — `clock.ts`'s `now`/`monotonic`, plus `sleep`. `ambientClock()`'s
 * default and `./adapter`'s `systemClock`. The barrel and `./page` export `clock.ts`'s, which has no
 * `sleep`: `time`, `money` and `realtime` read it in the browser, where no caller waits (axiom 6).
 */
export const systemClock: SleepClock = /* @__PURE__ */ Object.freeze({
  now: wallClock.now,
  monotonic: wallClock.monotonic,
  sleep: sleepFor,
});

/**
 * The system clock with the waiting taken out: `now()` and `monotonic()` are real, every `sleep` is
 * ONE turn of the event loop. For a test whose wait ends on something that really happens in the
 * same process, where a frozen clock's "sleeping is advancing" would run a deadline out in microtasks.
 */
export const noWaitClock: SleepClock = /* @__PURE__ */ Object.freeze({
  now: () => systemClock.now(),
  monotonic: () => systemClock.monotonic(),
  sleep: (_ms: number, signal?: AbortSignal) => sleepFor(0, signal),
});

export const ambientClock = (): SleepClock => installedClocks.current() ?? systemClock;

/**
 * The installer behind `ambientClock()`. Returns the RELEASE, which removes this install alone —
 * any stop order, idempotent (`adapter-slot.ts`). The shape every port installer takes.
 */
export function installClock(next: SleepClock): () => void {
  return installedClocks.install(next);
}
