// Owns one question `lifecycle.test.ts` and `lifecycle-deadline.test.ts` never asked: what a drain
// does when the BUDGET it was configured with is not a number. `configureLifecycle` assigned it
// unscreened, `Math.max(0, deadlineAt - monotonic())` propagated the NaN, and `setTimeout(fn, NaN)`
// is `setTimeout(fn, 0)` — so a deploy dropped in-flight work and abandoned every close hook on the
// first tick while `X_SHUTDOWN_TIMEOUT` rendered `NaNms` and told the operator to raise a budget.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { renderThrowable } from './error-render';
import { isUltimateError, type UltimateError } from './errors';
import {
  beginWork,
  configureLifecycle,
  drain,
  drainDeadlineMs,
  inflightCount,
  markReady,
  onShutdown,
  resetLifecycle,
} from './lifecycle';
import { structuredLogger } from './logger';

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  jest.useRealTimers();
  resetLifecycle();
});

/** Moves Bun's fake clock `ms` 1 ms at a time, letting the promise jobs each fired timer queued run. */
async function moveClock(ms: number): Promise<void> {
  for (let i = 0; i < ms; i += 1) {
    jest.advanceTimersByTime(1);
    for (let m = 0; m < 20; m += 1) await Promise.resolve();
  }
}

/**
 * Moves Bun's fake clock 1 ms at a time, letting the promise jobs each fired timer queued run, until
 * `drained` settles — so a timer past the drain's end (an abandoned hook's) is never fired — or
 * `ms` runs out.
 */
async function drainOver(drained: Promise<void>, ms: number): Promise<void> {
  let settled = false;
  void drained.then(() => {
    settled = true;
  });
  for (let m = 0; m < 20; m += 1) await Promise.resolve();
  for (let i = 0; i < ms && !settled; i += 1) {
    jest.advanceTimersByTime(1);
    for (let m = 0; m < 20; m += 1) await Promise.resolve();
  }
  if (!settled) expect.unreachable(`the drain was still running ${ms} fake ms in`);
}

const caught = (fn: () => unknown): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable(`expected an UltimateError, got ${renderThrowable(thrown)}`);
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

describe('configureLifecycle deadlineMs', () => {
  for (const deadlineMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5]) {
    test(`refuses ${String(deadlineMs)}, and the budget already in force is untouched`, () => {
      const before = drainDeadlineMs();
      expect(caught(() => configureLifecycle({ deadlineMs })).code).toBe('X_INVARIANT');
      // Screened ABOVE the write, so the refusal is not also a mutation: a boot that refuses the
      // declaration must not leave the process running on the value it refused.
      expect(drainDeadlineMs()).toBe(before);
    });
  }

  test('the refusal names configureLifecycle and deadlineMs, which is what makes it one edit', () => {
    const error = caught(() => configureLifecycle({ deadlineMs: Number.NaN }));
    expect(error.cause).toContain('configureLifecycle');
    expect(error.cause).toContain('deadlineMs');
    expect(error.fix).toContain('deadlineMs');
  });

  /**
   * The floor is 0, not 1, and this is the test that says so. `0` is a real budget — "drain now,
   * no grace", which `settleWithin` handles deliberately (a resolved promise settles on a
   * microtask and its timer on a macrotask, so a synchronous hook still gets its turn).
   */
  test('zero is a budget, not a mistake — the floor mutation test', () => {
    configureLifecycle({ deadlineMs: 0 });
    expect(drainDeadlineMs()).toBe(0);
  });

  test('a real budget passes through unchanged — the non-vacuity half', () => {
    configureLifecycle({ deadlineMs: 600_000 });
    expect(drainDeadlineMs()).toBe(600_000);
  });
});

describe('the drain a non-numeric budget produced', () => {
  /**
   * Written to run on BOTH sides of the repair, so it is a reproduction and not just a throw
   * assertion. Before it, `configureLifecycle` stored the NaN and every expectation below failed:
   * `drain()` returned in ~1ms with work still in flight, the 60ms close hook was ABANDONED, and
   * two `X_SHUTDOWN_TIMEOUT` lines said so. After it, the refusal is what keeps them true.
   */
  test('never happens: work still finishes and the close hook still runs', async () => {
    const lines: string[] = [];
    configureLifecycle({
      logger: structuredLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    try {
      configureLifecycle({ deadlineMs: Number.NaN });
    } catch {
      // The refusal is the point. Swallowed so the drain below runs on the pre-fix tree too.
    }

    // Fake timers, and no delay of the test's own: the work and the close hook end when the test
    // says, 40 and 60 fake ms in. A NaN budget is `setTimeout(fn, 0)`, which the first millisecond
    // the test moves already fires — so before the refusal, both waits were abandoned right there.
    jest.useFakeTimers();
    markReady();
    const finish = beginWork();
    const closeMayEnd = Promise.withResolvers<void>();
    let hookFinished = false;
    onShutdown('slow-close', async () => {
      await closeMayEnd.promise;
      hookFinished = true;
    });

    const drained = drain('SIGTERM');
    await moveClock(40);
    finish();
    await moveClock(60);
    closeMayEnd.resolve();
    await drainOver(drained, 200);

    expect(inflightCount()).toBe(0);
    expect(hookFinished).toBe(true);
    expect(lines.some((line) => line.includes('X_SHUTDOWN_TIMEOUT'))).toBe(false);
  });
});
