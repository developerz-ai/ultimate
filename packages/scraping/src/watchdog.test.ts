// The two named incidents, as tests. One run held a queue slot for 3h11m with an open socket and
// no timeout armed; another left a browser alive after its run and pinned the queue until a
// redeploy. Both are one mechanism away, and this file is that mechanism failing on purpose.

import { describe, expect, test } from 'bun:test';
import type { SleepClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { createWedgeGuard } from './watchdog';

const settled = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => resolve()));

/** Spin the microtask queue until the guard ends the run, or give up — never a wall-clock wait. */
const untilFired = async (guard: { readonly fired: boolean }): Promise<void> => {
  for (let tick = 0; tick < 20 && !guard.fired; tick += 1) await settled();
};

/**
 * A clock whose first `failures` sleeps reject. `SleepClock` is a seam an app may implement, so
 * this is INPUT to the code under test and not a verdict thrown by the test.
 */
const brittleClock = (failures: number): SleepClock => {
  const base = frozenClock();
  let calls = 0;
  return {
    now: () => base.now(),
    monotonic: () => base.monotonic(),
    sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
      calls += 1;
      // `Promise.reject(new Error(…))` rather than `throw`: the error is the guard's INPUT and not
      // this test's verdict, and `scripts/test-bare-error.ts` separates the two on the `throw`.
      if (calls <= failures) return Promise.reject(new Error('the clock stopped'));
      await base.sleep(ms, signal);
    },
  };
};

describe('unit · the inactivity watchdog', () => {
  test('silence past idleMs KILLS the process and aborts with X_SCRAPE_WEDGED', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    await untilFired(guard);
    expect(guard.fired).toBe(true);
    expect(killed).toBe(1);
    expect(guard.signal.aborted).toBe(true);
    expect((guard.signal.reason as { code?: string }).code).toBe('X_SCRAPE_WEDGED');
  });

  test('a kill that THROWS still aborts the run with X_SCRAPE_WEDGED', async () => {
    const guard = createWedgeGuard({
      clock: frozenClock(),
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: () => Promise.resolve(),
      // A driver's kill failing is INPUT here: a parse that throws, not this test's verdict.
      kill: () => JSON.parse('{'),
    });
    await untilFired(guard);
    for (let tick = 0; tick < 20 && !guard.signal.aborted; tick += 1) await settled();
    expect((guard.signal.reason as { code?: string } | undefined)?.code).toBe('X_SCRAPE_WEDGED');
  });

  test('a run that keeps touching is never killed', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    for (let tick = 0; tick < 20; tick += 1) {
      guard.touch();
      await settled();
    }
    expect(guard.fired).toBe(false);
    expect(killed).toBe(0);
    await guard.shutdown();
  });
});

describe('unit · the graceful-quit ceiling', () => {
  test('a quit that returns in time is not followed by a kill', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 5_000,
      quit: () => Promise.resolve(),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(0);
  });

  test('a quit that never returns is killed at the ceiling — the zombie incident', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 5_000,
      // `browser.close()` on a wedged renderer never returns. Waiting for it is the incident.
      quit: () => new Promise<void>(() => undefined),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(1);
  });

  test('a quit that THROWS is still killed — a failed close is not a closed browser', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      quit: () => Promise.reject(new Error('detached')),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(1);
  });
});

/**
 * The half the ceiling tests above could not see: `shutdown()` returned early whenever the
 * watchdog had already fired, because both the fire and the shutdown latched the SAME `stopped`
 * flag. On `localBrowser()` the fire's `kill()` still reaches a pid, so the leak was invisible —
 * but `remoteBrowser()` is the primary production path (`driver-cdp.ts`), `browser.process()`
 * answers `null` there, and `quit()` (`browser.close()`) is then the only thing that ends a
 * session somebody is billing for. A fired watchdog ended nothing at all.
 */
describe('unit · shutdown AFTER the watchdog fired', () => {
  test('the graceful quit still runs — the remote session is not left billing', async () => {
    const clock = frozenClock();
    let quits = 0;
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: async (): Promise<void> => {
        quits += 1;
      },
      kill: () => {
        killed += 1;
      },
    });
    await untilFired(guard);
    expect(guard.fired).toBe(true);
    await guard.shutdown();
    expect(quits).toBe(1);
    // The fire's kill, and no second one: the quit came back inside the ceiling.
    expect(killed).toBe(1);
  });

  test('a quit that never returns is killed at the ceiling after a fire too', async () => {
    const clock = frozenClock();
    let killed = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 1_000,
      graceMs: 5_000,
      quit: () => new Promise<void>(() => undefined),
      kill: () => {
        killed += 1;
      },
    });
    await untilFired(guard);
    await guard.shutdown();
    expect(killed).toBe(2);
  });

  test('shutdown stays idempotent — two calls are one quit', async () => {
    const clock = frozenClock();
    let quits = 0;
    const guard = createWedgeGuard({
      clock,
      what: 'scrape "orders"',
      idleMs: 60_000,
      quit: async (): Promise<void> => {
        quits += 1;
      },
      kill: () => undefined,
    });
    await guard.shutdown();
    await guard.shutdown();
    expect(quits).toBe(1);
  });
});

/**
 * `void watch()` was floating. A `SleepClock` is a seam an app implements, and one whose `sleep`
 * rejects turned the guard's own loop into an UNHANDLED REJECTION — a process-level event in a
 * worker, attributed to no run. Worse than the noise: the loop was dead, so nothing measured
 * inactivity, which is verbatim incident #1 in `watchdog.ts`.
 */
describe('unit · a guard that can no longer watch', () => {
  test('a clock whose sleep REJECTS ends the run instead of leaving it unwatched', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const guard = createWedgeGuard({
        clock: brittleClock(1),
        what: 'scrape "orders"',
        idleMs: 1_000,
        quit: () => Promise.resolve(),
        kill: () => undefined,
      });
      await untilFired(guard);
      expect(guard.signal.aborted).toBe(true);
      const reason = guard.signal.reason as { code?: string; cause?: string };
      // Its OWN code, not the wedge's. `x errors explain X_SCRAPE_WEDGED` answers "the browser
      // stopped answering and was killed" and tells the reader to raise `idleMs` — a page that is
      // fine and a repair that does nothing. The browser never stopped answering here; the guard's
      // own loop died on a clock the definition supplied, which is why the two are also classified
      // differently (retryable vs terminal).
      expect(reason.code).toBe('X_SCRAPE_WATCHDOG_STOPPED');
      expect(reason.code).not.toBe('X_SCRAPE_WEDGED');
      // The thrown value is RENDERED, never interpolated: `renderThrowable`, per `error-throws.ts`.
      expect(reason.cause).toContain('the clock stopped');
      expect(reason.cause).toContain('stopped measuring');
      await guard.shutdown();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    await settled();
    expect(unhandled).toEqual([]);
  });

  test('a grace sleep that rejects still kills — close() may never throw', async () => {
    let killed = 0;
    const guard = createWedgeGuard({
      // Two failures: the watch poll, then the ceiling's own sleep inside `shutdown()`.
      clock: brittleClock(2),
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 5_000,
      quit: () => new Promise<void>(() => undefined),
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(killed).toBe(1);
  });
});

/**
 * The fire IS the teardown. On `remoteBrowser()` the kill reaches nothing (`process()` is `null`),
 * and a `quit()` that waited for `shutdown()` waited for the run to unwind — which a call blocked on
 * the socket never does. One adopter's run drove the site for minutes after its guard fired.
 */
describe('unit · the fire closes the browser, not the unwind', () => {
  test('a fire with a no-op kill runs the quit once, and a later shutdown adds none', async () => {
    let quits = 0;
    const guard = createWedgeGuard({
      clock: frozenClock(),
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: async (): Promise<void> => {
        quits += 1;
      },
      kill: () => undefined,
    });
    await untilFired(guard);
    expect(guard.fired).toBe(true);
    expect(quits).toBe(1);
    await guard.shutdown();
    expect(quits).toBe(1);
  });

  test('a hung quit after a fire gets a second kill at graceMs, without any shutdown', async () => {
    let killed = 0;
    const guard = createWedgeGuard({
      clock: frozenClock(),
      what: 'scrape "orders"',
      idleMs: 1_000,
      graceMs: 5_000,
      quit: () => new Promise<void>(() => undefined),
      kill: () => {
        killed += 1;
      },
    });
    await untilFired(guard);
    expect(killed).toBe(1);
    for (let tick = 0; tick < 5; tick += 1) await settled();
    expect(killed).toBe(2);
    // And the shutdown that follows shares that teardown rather than starting a third kill.
    await guard.shutdown();
    expect(killed).toBe(2);
  });

  test('the kill still precedes the abort, and the quit starts before the abort is seen', async () => {
    const order: string[] = [];
    const guard = createWedgeGuard({
      clock: frozenClock(),
      what: 'scrape "orders"',
      idleMs: 1_000,
      quit: async (): Promise<void> => {
        order.push('quit');
      },
      kill: () => {
        order.push('kill');
      },
    });
    guard.signal.addEventListener('abort', () => order.push('abort'));
    await untilFired(guard);
    expect(order).toEqual(['kill', 'quit', 'abort']);
  });
});
