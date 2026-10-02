import { describe, expect, test } from 'bun:test';
import { BAR_CHART, barRects, GRID_STEPS, gridY, maxOf, secondaryRects } from './bar-chart-view';

const points = (...values: number[]) => values.map((value, i) => ({ key: `d${i}`, value }));

describe('maxOf', () => {
  test('is the busiest point, never below 1, ignoring a non-finite value', () => {
    expect(maxOf(points(3, 9, 4))).toBe(9);
    expect(maxOf(points(0, 0))).toBe(1);
    expect(maxOf([])).toBe(1);
    expect(maxOf(points(2, Number.NaN))).toBe(2);
  });
});

describe('gridY', () => {
  test('the top line is the busiest point and the bottom line the baseline', () => {
    expect(gridY(1)).toBe(BAR_CHART.top);
    expect(gridY(0)).toBe(BAR_CHART.top + BAR_CHART.plot);
    expect(GRID_STEPS).toHaveLength(4);
  });
});

describe('barRects', () => {
  test('bars tile the width with one gap between neighbours and the busiest fills the plot', () => {
    const rects = barRects(points(1, 4, 2));
    expect(rects).toHaveLength(3);
    const last = rects[2] as { x: number; width: number };
    expect(last.x + last.width).toBeCloseTo(BAR_CHART.width);
    expect(rects[1]?.height).toBe(BAR_CHART.plot);
    expect(rects[1]?.y).toBe(BAR_CHART.top);
  });

  test('a zero still draws a 2px bar, so an empty day is visible and not a gap', () => {
    expect(barRects(points(0, 10))[0]?.height).toBe(2);
  });

  test('a negative or non-finite value draws as zero rather than escaping the plot', () => {
    const rects = barRects(points(-5, Number.NaN, 5));
    expect(rects[0]?.height).toBe(2);
    expect(rects[1]?.height).toBe(2);
  });

  test('no points is no bars', () => {
    expect(barRects([])).toEqual([]);
  });
});

describe('a second series', () => {
  const stacked = (...pairs: [number, number][]) =>
    pairs.map(([value, secondary], i) => ({ key: `d${i}`, value, secondary }));

  test('scales by the stacked total, so the tallest stack fills the plot', () => {
    expect(maxOf(stacked([3, 1], [2, 6]))).toBe(8);
    const rects = barRects(stacked([3, 1], [2, 6]));
    const tops = secondaryRects(stacked([3, 1], [2, 6]));
    expect((rects[1]?.height ?? 0) + (tops[1]?.height ?? 0)).toBeCloseTo(BAR_CHART.plot);
    // Stacked ON the primary bar: its bottom is the primary's top.
    expect((tops[1]?.y ?? 0) + (tops[1]?.height ?? 0)).toBeCloseTo(rects[1]?.y ?? -1);
  });

  test('a zero or absent secondary draws nothing, and the primary alone is unchanged', () => {
    expect(secondaryRects(stacked([4, 0]))[0]).toBeNull();
    expect(secondaryRects(points(4))[0]).toBeNull();
    expect(barRects(points(1, 4, 2))).toEqual(barRects(stacked([1, 0], [4, 0], [2, 0])));
  });
});
