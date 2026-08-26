// The watchdog's two budgets when they are not numbers, in their own file: `watchdog.test.ts` is
// about a guard that fires correctly, and every test here is about a guard that must never be
// built. Both failures are silent in the direction that costs money — a `NaN` idleMs makes
// `elapsed < idleMs` false on the FIRST poll, so the browser is killed 250ms into every run and
// the run reports `X_SCRAPE_WEDGED` about a page that answered; a `NaN` graceMs makes the quit
// ceiling zero, so `browser.close()` never wins the race and a `remoteBrowser()` session — where
// `process()` is `null` and `kill()` reaches nothing — runs until its provider times it out.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { testClock } from './clock';
import { createWedgeGuard } from './watchdog';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

/** The refusal `run` made, or the assertion that it made none. `renderThrowable`: `String` is not total. */
function refusal(run: () => unknown): { code: string; cause: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a watchdog budget that is not a number was accepted');
}

const guardWith = (over: { idleMs?: number; graceMs?: number }): (() => unknown) => {
  const kills: number[] = [];
  return () =>
    createWedgeGuard({
      clock: testClock(),
      what: 'scrape "orders"',
      ...over,
      quit: () => Promise.resolve(),
      kill: () => kills.push(1),
    });
};

describe('unit · a watchdog budget that is not a number', () => {
  for (const value of NOT_A_BOUND) {
    test(`idleMs of ${String(value)} is refused rather than firing on the first poll`, () => {
      const error = refusal(guardWith({ idleMs: value }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('idleMs');
    });

    test(`graceMs of ${String(value)} is refused rather than killing before the quit`, () => {
      const error = refusal(guardWith({ graceMs: value }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('graceMs');
    });
  }

  // The floor, and it is a claim: `idleMs: 0` means "kill the browser at the first poll", which is
  // every run of every scrape and is the same outcome as the `NaN` above. `graceMs: 0` is NOT the
  // same claim — it says "kill immediately, do not wait for the polite close", which is a real
  // policy a caller can hold — so 0 is legal there and only there.
  test('idleMs 0 is refused; graceMs 0 is a caller declining the polite close', async () => {
    expect(refusal(guardWith({ idleMs: 0 })).cause).toContain('idleMs');
    let quit = 0;
    let killed = 0;
    const guard = createWedgeGuard({
      clock: testClock(),
      what: 'scrape "orders"',
      idleMs: 60_000,
      graceMs: 0,
      quit: () => {
        quit += 1;
        return new Promise<void>(() => undefined);
      },
      kill: () => {
        killed += 1;
      },
    });
    await guard.shutdown();
    expect(quit).toBe(1);
    expect(killed).toBe(1);
  });

  test('the ordinary budgets are still accepted', () => {
    const guard = createWedgeGuard({
      clock: testClock(),
      what: 'scrape "orders"',
      idleMs: 1,
      graceMs: 5_000,
      quit: () => Promise.resolve(),
      kill: () => undefined,
    });
    expect(guard.fired).toBe(false);
  });
});
