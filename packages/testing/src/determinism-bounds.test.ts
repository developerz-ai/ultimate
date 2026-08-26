// The frozen clock's instant and the seeded RNG's seed, when neither is a number.
//
// Its own file because it is one question and because it needs its own teardown: everything here
// writes PROCESS state, and `bun test` is one process, so a poisoned instant left behind would
// fail a later file for a reason nothing in that file explains.
//
// `frozenAt` is the value that matters. `new Date('yesterday').getTime()` is `NaN`, so
// `installDeterminism({ now })` with anything the Date constructor cannot read makes `Date.now()`
// answer `NaN` and `new Date()` answer `Invalid Date` for every test in the run — and every
// `expiresAt > Date.now()` in the framework then reads false, which is the defect class, installed
// globally by the harness whose entire promise is a clock a test can trust. `advanceClock` writes
// the same variable and cannot repair it: `NaN + 1000` is `NaN` forever.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import {
  advanceClock,
  captureDeterminism,
  frozenClock,
  frozenNow,
  installDeterminism,
  restoreCapturedDeterminism,
  seededRandom,
  setFrozenClock,
} from './determinism';

const NOT_AN_INSTANT: readonly (string | number)[] = [
  'yesterday',
  '',
  Number.NaN,
  Number.POSITIVE_INFINITY,
];

/** `JSON.stringify(NaN)` is `"null"`, which would give two of these tests the same name. */
const label = (value: string | number): string =>
  typeof value === 'string' ? `'${value}'` : String(value);

const NOT_A_SEED: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0.5,
];

// Captured at module scope and restored after EVERY test, including the ones that throw: a
// refusal leaves the previous instant in place, and an acceptance must not leak the new one.
const captured = captureDeterminism();
afterEach(() => {
  restoreCapturedDeterminism(captured);
});

/** The same, for `frozenClock`, which is `async` and so REJECTS rather than throwing. */
async function asyncRefusal(run: () => Promise<unknown>): Promise<{ code: string; cause: string }> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('an instant the Date constructor cannot read was installed');
}

function refusal(run: () => unknown): { code: string; cause: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('an instant the Date constructor cannot read was installed');
}

describe('unit · the frozen clock, bounded', () => {
  for (const value of NOT_AN_INSTANT) {
    test(`installDeterminism refuses now: ${label(value)}`, () => {
      const error = refusal(() => {
        installDeterminism({ now: value });
      });
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('now');
      // The refusal is TOTAL: the instant that was there is still there, so a bad option cannot
      // leave the process half-installed on an Invalid Date.
      expect(Number.isFinite(Date.now())).toBe(true);
    });

    test(`setFrozenClock refuses ${label(value)}`, () => {
      const error = refusal(() => {
        setFrozenClock(value);
      });
      expect(error.cause).toContain('now');
      expect(Number.isFinite(frozenNow().getTime())).toBe(true);
    });
  }

  test('frozenClock refuses an unreadable instant and leaves the outer one alone', async () => {
    installDeterminism({ now: '2026-01-01T00:00:00.000Z' });
    const before = Date.now();
    let ran = false;
    const error = await asyncRefusal(() =>
      frozenClock('the day before', () => {
        ran = true;
      }),
    );
    expect(error.cause).toContain('now');
    expect(ran).toBe(false);
    expect(Date.now()).toBe(before);
  });

  test('advanceClock refuses a duration that is not a number, which nothing could undo', () => {
    installDeterminism({ now: '2026-01-01T00:00:00.000Z' });
    const before = Date.now();
    const error = refusal(() => advanceClock(Number.NaN));
    expect(error.cause).toContain('ms');
    // The reason this one is refused rather than clamped: `frozenAt` is a single number, so one
    // `NaN` addition poisons every later read AND every later `advance` in the process.
    expect(Date.now()).toBe(before);
    advanceClock(1_000);
    expect(Date.now()).toBe(before + 1_000);
  });

  test('a negative advance is legal — a test may move the clock backwards', () => {
    installDeterminism({ now: '2026-01-01T00:00:00.000Z' });
    const before = Date.now();
    expect(advanceClock(-1_000).getTime()).toBe(before - 1_000);
  });

  test('the instants a harness actually passes still install', () => {
    installDeterminism({ now: '2030-06-01T12:00:00.000Z' });
    expect(new Date().toISOString()).toBe('2030-06-01T12:00:00.000Z');
    installDeterminism({ now: 0 });
    expect(Date.now()).toBe(0);
  });
});

describe('unit · the seed, bounded', () => {
  // MEASURED first, because a seed is not a bound and the honest answer decides whether screening
  // it is a repair or noise: `seededRandom` starts at `seed >>> 0`, which maps `NaN`, `±Infinity`,
  // `0.5` and `2 ** 32` all to 0. So a non-finite seed does NOT make a run non-deterministic — it
  // silently makes it the seed-0 run. The defect is a seed that is not the seed you passed, which
  // is exactly what `Number.parseInt(process.env.ULTIMATE_TEST_SEED ?? '')` produces when the
  // variable is unset, and `preload.ts` already screens that one caller by hand.
  test('the collapse this screens: every unreadable seed IS seed 0', () => {
    const zero = seededRandom(0);
    const first = zero();
    for (const value of NOT_A_SEED) expect(seededRandom(value)()).toBe(first);
  });

  for (const value of NOT_A_SEED) {
    test(`installDeterminism refuses seed: ${String(value)} rather than aliasing it to 0`, () => {
      const error = refusal(() => {
        installDeterminism({ seed: value });
      });
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('seed');
    });
  }

  test('seed 0 is a seed like any other and is accepted', () => {
    installDeterminism({ seed: 0 });
    expect(Math.random()).toBe(seededRandom(0)());
  });
});
