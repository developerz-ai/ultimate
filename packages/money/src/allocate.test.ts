import { describe, expect, test } from 'bun:test';
import {
  allocate,
  allocateByPercentages,
  allocateByRatios,
  assertAllocationSums,
} from './allocate';
import { sum } from './arithmetic';
import { money } from './money';

const minors = (parts: readonly { minor: number }[]) => parts.map((part) => part.minor);

describe('allocate', () => {
  test('100 minor units three ways lose nothing', () => {
    const parts = allocate(money(100, 'USD'), 3);
    expect(minors(parts)).toEqual([34, 33, 33]);
    expect(sum(parts).minor).toBe(100);
  });

  test('every split from 1 to 97 parts reconstructs the total', () => {
    for (let count = 1; count <= 97; count += 1) {
      const parts = allocate(money(1_000_003, 'USD'), count);
      expect(parts).toHaveLength(count);
      expect(sum(parts).minor).toBe(1_000_003);
    }
  });

  test('negative totals (a refund) split without gaining a cent', () => {
    const parts = allocate(money(-100, 'USD'), 3);
    expect(minors(parts)).toEqual([-34, -33, -33]);
    expect(sum(parts).minor).toBe(-100);
  });

  test('zero-decimal currencies work the same way', () => {
    const parts = allocate(money(10, 'JPY'), 3);
    expect(minors(parts)).toEqual([4, 3, 3]);
    expect(sum(parts).minor).toBe(10);
  });

  test('rejects a nonsensical part count', () => {
    expect(codeOf(() => allocate(money(100, 'USD'), 0))).toBe('X_ALLOCATION_INVALID');
    expect(codeOf(() => allocate(money(100, 'USD'), 2.5))).toBe('X_ALLOCATION_INVALID');
  });
});

describe('allocateByRatios', () => {
  test('revenue share by weights preserves the total', () => {
    const parts = allocateByRatios(money(1000, 'USD'), [70, 20, 10]);
    expect(minors(parts)).toEqual([700, 200, 100]);
    expect(sum(parts).minor).toBe(1000);
  });

  test('largest remainder wins the leftover unit, deterministically', () => {
    // 5 units over weights 1:1:1 → 1.66/1.66/1.66 → floors 1/1/1, 2 left over.
    expect(minors(allocateByRatios(money(5, 'USD'), [1, 1, 1]))).toEqual([2, 2, 1]);
    // Repeat runs must not reshuffle: invoices have to be reproducible.
    expect(minors(allocateByRatios(money(5, 'USD'), [1, 1, 1]))).toEqual([2, 2, 1]);
    expect(minors(allocateByRatios(money(100, 'USD'), [1, 0]))).toEqual([100, 0]);
  });

  test('rejects invalid ratios', () => {
    expect(codeOf(() => allocateByRatios(money(100, 'USD'), []))).toBe('X_ALLOCATION_INVALID');
    expect(codeOf(() => allocateByRatios(money(100, 'USD'), [0, 0]))).toBe('X_ALLOCATION_INVALID');
    expect(codeOf(() => allocateByRatios(money(100, 'USD'), [1, -1]))).toBe('X_ALLOCATION_INVALID');
  });
});

describe('allocateByPercentages', () => {
  test('percentages must sum to 100', () => {
    expect(minors(allocateByPercentages(money(100, 'USD'), [33.33, 33.33, 33.34]))).toEqual([
      33, 33, 34,
    ]);
    expect(codeOf(() => allocateByPercentages(money(100, 'USD'), [50, 40]))).toBe(
      'X_ALLOCATION_INVALID',
    );
  });
});

describe('allocation at a scale of its own', () => {
  test('the 100.01-across-3 property holds at scale 2 and at scale 6 alike', () => {
    const cents = allocate(money(10_001, 'USD'), 3);
    expect(minors(cents)).toEqual([3334, 3334, 3333]);
    expect(sum(cents)).toEqual({ minor: 10_001, currency: 'USD' });

    const micros = allocate(money(100_010_000, 'USD', 6), 3);
    expect(minors(micros)).toEqual([33_336_667, 33_336_667, 33_336_666]);
    expect(sum(micros)).toEqual({ minor: 100_010_000, currency: 'USD', scale: 6 });
  });

  test('every part carries the total’s scale', () => {
    for (const part of allocateByRatios(money(100, 'USD', 6), [70, 20, 10])) {
      expect(part.scale).toBe(6);
    }
  });

  test('the split stays exact past 2^53, where the float product silently was not', () => {
    // `magnitude * ratio` overflowed the exact-integer range and floored to the wrong part —
    // a scale of 6 makes an amount that large 10,000x easier to reach.
    const total = money(9_007_199_254_740_991, 'USD', 6);
    const parts = allocateByRatios(total, [1, 1, 1]);
    expect(sum(parts)).toEqual(total);
    expect(minors(parts)).toEqual([
      3_002_399_751_580_331, 3_002_399_751_580_330, 3_002_399_751_580_330,
    ]);
  });
});

describe('assertAllocationSums', () => {
  test('accepts what allocate() produced, for every part count it produced it at', () => {
    for (const parts of [2, 3, 7, 97]) {
      const total = money(10_000, 'USD');
      expect(() => assertAllocationSums(total, allocate(total, parts))).not.toThrow();
    }
  });

  test('a lost minor unit is reported with the whole, the sum and how much went', () => {
    const cause = causeOf(() =>
      assertAllocationSums(money(100, 'USD'), [
        money(34, 'USD'),
        money(33, 'USD'),
        money(32, 'USD'),
      ]),
    );
    expect(cause).toContain('USD 100');
    expect(cause).toContain('sums to 99');
    expect(cause).toContain('at scale 2');
    // Signed from the whole's point of view: one unit SHORT is `1 … lost`, not `-1`.
    expect(cause).toContain('1 minor unit(s) lost');
    // And a split that overshoots reports the other direction rather than passing.
    expect(
      causeOf(() => assertAllocationSums(money(100, 'USD'), [money(60, 'USD'), money(41, 'USD')])),
    ).toContain('-1 minor unit(s) lost');
    expect(
      codeOf(() => assertAllocationSums(money(100, 'USD'), [money(60, 'USD'), money(41, 'USD')])),
    ).toBe('X_ALLOCATION_INVALID');
  });

  test('parts split finer than the whole reconcile against it at the finer scale', () => {
    // $1.00 as two half-dollar amounts carried in micro-dollars. Summing at the WHOLE's scale
    // would have to narrow the parts, which is refused — so the finest scale present is the one
    // that has to be used.
    const halves = [money(500_000, 'USD', 6), money(500_000, 'USD', 6)];
    expect(() => assertAllocationSums(money(100, 'USD'), halves)).not.toThrow();
    // One micro-dollar short is still short, which is the point of reconciling at scale 6.
    const cause = causeOf(() =>
      assertAllocationSums(money(100, 'USD'), [money(500_000, 'USD', 6), money(499_999, 'USD', 6)]),
    );
    expect(cause).toContain('at scale 6');
    expect(cause).toContain('1 minor unit(s) lost');
  });

  test('a part in another currency is a mismatch, not an arithmetic error', () => {
    expect(
      codeOf(() => assertAllocationSums(money(100, 'USD'), [money(50, 'USD'), money(50, 'EUR')])),
    ).toBe('X_CURRENCY_MISMATCH');
  });

  test('an empty part list against a non-zero whole loses all of it', () => {
    expect(codeOf(() => assertAllocationSums(money(100, 'USD'), []))).toBe('X_ALLOCATION_INVALID');
    expect(() => assertAllocationSums(money(0, 'USD'), [])).not.toThrow();
  });
});

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
