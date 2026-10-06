import { describe, expect, test } from 'bun:test';
import {
  axisLabelIndices,
  categoryLabels,
  minorTicks,
  NARROW_LABELS,
  niceStep,
  niceTicks,
  tickDecimals,
  WIDE_LABELS,
} from './chart-ticks-view';

/** The mantissa of a 1-2-5 step: 1, 2 or 5 times a power of ten. */
const mantissa = (step: number): number => {
  const exp = Math.floor(Math.log10(step));
  return Number((step / 10 ** exp).toPrecision(6));
};

describe('niceStep', () => {
  test('is the largest 1-2-5 step at or below the raw step', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.9)).toBe(1);
    expect(niceStep(2.25)).toBe(2);
    expect(niceStep(4.99)).toBe(2);
    expect(niceStep(5)).toBe(5);
    expect(niceStep(9.9)).toBe(5);
    expect(niceStep(0.03)).toBe(0.02);
    expect(niceStep(730)).toBe(500);
  });

  test('a zero, negative or non-finite raw step is 1, never a NaN loop', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-3)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
    expect(niceStep(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('niceTicks', () => {
  test('0..9 in at most 6 ticks is 0, 2, … 10 — the densest 1-2-5 labelling under the cap', () => {
    expect(niceTicks(0, 9, 6)).toEqual({ min: 0, max: 10, step: 2, ticks: [0, 2, 4, 6, 8, 10] });
  });

  test('every answer covers the data, stays under the cap and steps by 1, 2 or 5 × 10ⁿ', () => {
    const cases: [number, number, number][] = [
      [0, 1, 6],
      [0, 7, 6],
      [0, 97, 6],
      [3, 1234, 5],
      [-40, 55, 6],
      [0.001, 0.0137, 6],
      [1_000_000, 4_900_000, 4],
      [0, 100, 3],
      [12, 13, 6],
    ];
    for (const [lo, hi, max] of cases) {
      const scale = niceTicks(lo, hi, max);
      expect([lo, hi, scale.min <= lo]).toEqual([lo, hi, true]);
      expect([lo, hi, scale.max >= hi]).toEqual([lo, hi, true]);
      expect(scale.ticks.length).toBeLessThanOrEqual(max);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
      expect([1, 2, 5]).toContain(mantissa(scale.step));
      expect(scale.ticks[0]).toBe(scale.min);
      expect(scale.ticks.at(-1)).toBe(scale.max);
    }
  });

  test('ticks are exact decimals, never 0.30000000000000004', () => {
    const { ticks } = niceTicks(0, 0.7, 8);
    expect(ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  test('a flat series still gets a scale with height: all-zero is 0..1', () => {
    expect(niceTicks(0, 0, 6).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const flat = niceTicks(500, 500, 6);
    expect(flat.min).toBeLessThan(500);
    expect(flat.max).toBeGreaterThan(500);
  });

  test('a reversed or non-finite bound is repaired rather than looping', () => {
    expect(niceTicks(10, 0, 6).ticks).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(Number.NaN, 5, 6).ticks.length).toBeGreaterThanOrEqual(2);
    // A cap under 2 cannot draw an axis; it is read as 2.
    expect(niceTicks(0, 10, 1).ticks).toHaveLength(2);
  });
});

describe('niceTicks — integer data', () => {
  test('a small count gets whole steps, never 0.4 or 0.5 between two whole numbers', () => {
    expect(niceTicks(0, 3, 6, { integer: true }).ticks).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0, 2, 6, { integer: true }).ticks).toEqual([0, 1, 2]);
    expect(niceTicks(0, 7, 6, { integer: true }).ticks).toEqual([0, 2, 4, 6, 8]);
    // Without the flag the same range is labelled in fractions — the bug this exists for.
    expect(niceTicks(0, 2, 6).step).toBeLessThan(1);
  });

  test('every integer scale steps by a whole number and ends at or above the max', () => {
    for (const hi of [0, 1, 2, 3, 4, 5, 9, 11, 37]) {
      const scale = niceTicks(0, hi, 6, { integer: true });
      expect([hi, Number.isInteger(scale.step) && scale.step >= 1]).toEqual([hi, true]);
      expect(scale.ticks.every(Number.isInteger)).toBe(true);
      expect(scale.max).toBeGreaterThanOrEqual(hi);
    }
  });

  test('an all-zero count is 0..1, whole', () => {
    expect(niceTicks(0, 0, 6, { integer: true }).ticks).toEqual([0, 1]);
  });
});

describe('tickDecimals', () => {
  test('is how many fraction digits a step needs', () => {
    expect(tickDecimals(5)).toBe(0);
    expect(tickDecimals(500)).toBe(0);
    expect(tickDecimals(0.5)).toBe(1);
    expect(tickDecimals(0.02)).toBe(2);
  });
});

describe('axisLabelIndices', () => {
  test('every key is labelled when they fit under the cap', () => {
    expect(axisLabelIndices(3, 6)).toEqual([0, 1, 2]);
  });

  test('past the cap, an even stride counted back from the newest key, which is always shown', () => {
    expect(axisLabelIndices(10, 3)).toEqual([4, 9]);
    expect(axisLabelIndices(30, 6)).toEqual([5, 11, 17, 23, 29]);
  });

  test('labels never exceed the cap and are always an even stride apart', () => {
    for (const count of [2, 7, 8, 13, 31, 90, 365]) {
      for (const max of [2, 3, 6]) {
        const indices = axisLabelIndices(count, max);
        expect(indices.length).toBeLessThanOrEqual(max);
        expect(indices.at(-1)).toBe(count - 1);
        const strides = new Set(indices.slice(1).map((index, i) => index - (indices[i] ?? 0)));
        expect(strides.size).toBeLessThanOrEqual(1);
        // The stride is what keeps a label's width cap from colliding with its neighbour's.
        const stride = [...strides][0] ?? count;
        expect(stride * (max - 1)).toBeGreaterThanOrEqual(count - 1);
      }
    }
  });

  test('no keys is no labels; one key is that key', () => {
    expect(axisLabelIndices(0, 6)).toEqual([]);
    expect(axisLabelIndices(1, 6)).toEqual([0]);
  });
});

describe('categoryLabels — the axis a 390px phone and a 1440px desktop each read', () => {
  test('narrow labels are at most NARROW_LABELS, wide ones at most WIDE_LABELS', () => {
    for (const count of [1, 2, 5, 14, 30, 90]) {
      const labels = categoryLabels(count);
      expect(labels.filter((l) => l.narrow).length).toBeLessThanOrEqual(NARROW_LABELS);
      expect(labels.filter((l) => l.wide).length).toBeLessThanOrEqual(WIDE_LABELS);
      // Nothing is rendered that neither width shows.
      expect(labels.every((l) => l.narrow || l.wide)).toBe(true);
    }
    expect(NARROW_LABELS).toBeLessThan(WIDE_LABELS);
  });

  test('the newest key is labelled at every width, pinned to the end edge', () => {
    const last = categoryLabels(30).at(-1);
    expect(last).toEqual({ index: 29, narrow: true, wide: true, edge: 'end' });
  });

  test('the oldest key, when labelled, is pinned to the start edge; the rest are centred', () => {
    const labels = categoryLabels(3);
    expect(labels.map((l) => l.edge)).toEqual(['start', 'middle', 'end']);
  });

  test('a single key is centred, under the one point a single-key chart draws mid-plot', () => {
    expect(categoryLabels(1)).toEqual([{ index: 0, narrow: true, wide: true, edge: 'middle' }]);
  });
});

describe('minorTicks — which value labels a narrow chart drops', () => {
  test('every other label counted down from the TOP, so the highest is never the one dropped', () => {
    expect(minorTicks(6)).toEqual([true, false, true, false, true, false]);
    expect(minorTicks(5)).toEqual([false, true, false, true, false]);
    expect(minorTicks(3)).toEqual([false, false, false]);
    for (const count of [2, 4, 5, 6, 7]) expect(minorTicks(count).at(-1)).toBe(false);
  });
});
