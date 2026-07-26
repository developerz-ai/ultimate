import { describe, expect, test } from 'bun:test';
import { allocate, allocateByPercentages, allocateByRatios } from './allocate';
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

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
