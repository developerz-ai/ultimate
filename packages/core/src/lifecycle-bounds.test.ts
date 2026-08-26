// Owns one question `lifecycle.test.ts` and `lifecycle-deadline.test.ts` never asked: what a drain
// does when the BUDGET it was configured with is not a number. `configureLifecycle` assigned it
// unscreened, `Math.max(0, deadlineAt - monotonic())` propagated the NaN, and `setTimeout(fn, NaN)`
// is `setTimeout(fn, 0)` — so a deploy dropped in-flight work and abandoned every close hook on the
// first tick while `X_SHUTDOWN_TIMEOUT` rendered `NaNms` and told the operator to raise a budget.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { createLogger } from './logger';

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

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
   * microtask and its timer on a macrotask, so a synchronous hook still gets its turn) — and
   * `@ultimat3/http`'s `drainTimeoutMs` screens with `min: 0` and hands its value straight to this
   * function (`packages/http/src/server.ts:101`). A floor of 1 here would refuse a declaration
   * that package accepts, at boot, in every process that serves web.
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
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    try {
      configureLifecycle({ deadlineMs: Number.NaN });
    } catch {
      // The refusal is the point. Swallowed so the drain below runs on the pre-fix tree too.
    }

    markReady();
    const finish = beginWork();
    let hookFinished = false;
    onShutdown('slow-close', async () => {
      await Bun.sleep(60);
      hookFinished = true;
    });

    const drained = drain('SIGTERM');
    setTimeout(finish, 40);
    await drained;

    expect(inflightCount()).toBe(0);
    expect(hookFinished).toBe(true);
    expect(lines.some((line) => line.includes('X_SHUTDOWN_TIMEOUT'))).toBe(false);
  });
});
