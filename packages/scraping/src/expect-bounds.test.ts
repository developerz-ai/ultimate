// The silent-green alarm's own numbers, when they are not numbers.
//
// This is the file where the defect class is worst, because the alarm's whole job is to notice a
// run that succeeded and returned nothing. `rows < NaN` is false, so a `NaN` minRows is a floor
// that never fires — a scrape that returns zero rows forever, green forever, which is the exact
// failure `expect.ts` exists to prevent. A `NaN` window is the opposite kind of wrong: `[…]
// .slice(-NaN)` is `slice(0)`, so the baseline is the WHOLE history rather than the last seven,
// and the number is also handed to an app's own `history.recent(scrape, limit)`, which is usually
// a `limit` in SQL.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { guardYield, memoryYieldHistory, yieldProblem } from './expect';

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

async function refusal(run: () => Promise<unknown> | unknown): Promise<{
  code: string;
  cause: string;
}> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a yield expectation that is not a number was accepted');
}

describe('unit · the yield alarm, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`a window of ${String(value)} is refused rather than read as "all of history"`, async () => {
      const error = await refusal(() =>
        guardYield({
          scrape: 'orders',
          rows: 4,
          expect: { maxDrop: 0.5, window: value },
          history: memoryYieldHistory({ orders: [10, 10, 10] }),
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('window');
    });

    test(`a minRows of ${String(value)} is refused rather than never firing`, async () => {
      const error = await refusal(() =>
        yieldProblem({ scrape: 'orders', rows: 0, expect: { minRows: value }, history: [] }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('minRows');
    });

    test(`a maxDrop of ${String(value)} is refused rather than alarming on every run`, async () => {
      const error = await refusal(() =>
        yieldProblem({
          scrape: 'orders',
          rows: 10,
          expect: { maxDrop: value },
          history: [10, 10, 10],
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('maxDrop');
    });
  }

  // `window: 0` is refused because it is not "no baseline" — `slice(-0)` is `slice(0)`, the whole
  // history, which is the largest window there is. The floor is 1 for that reason and no other.
  test('a window of 0 is the whole history, not an empty one, and is refused', async () => {
    const error = await refusal(() =>
      guardYield({
        scrape: 'orders',
        rows: 4,
        expect: { maxDrop: 0.5, window: 0 },
        history: memoryYieldHistory({ orders: [10, 10, 10] }),
      }),
    );
    expect(error.cause).toContain('window');
  });

  // `minRows: 0` is the OPPOSITE claim and the file documents it: "a scrape whose real answer is
  // legitimately sometimes zero declares minRows: 0 — explicitly, so the reader can tell 'zero is
  // fine here' from 'nobody thought about it'". A floor of 1 here would refuse the declaration the
  // package asks authors to write.
  test('a minRows of 0 is a declaration, not a mistake, and is accepted', () => {
    expect(
      yieldProblem({ scrape: 'orders', rows: 0, expect: { minRows: 0 }, history: [] }),
    ).toBeUndefined();
  });

  test('a window of 1 is accepted, so the floor refuses zero and nothing above it', async () => {
    await guardYield({
      scrape: 'orders',
      rows: 10,
      expect: { maxDrop: 0.5, window: 1 },
      history: memoryYieldHistory({ orders: [10, 10, 10] }),
    });
    expect(true).toBe(true);
  });
});
