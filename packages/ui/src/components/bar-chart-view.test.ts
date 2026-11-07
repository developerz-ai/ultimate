import { describe, expect, test } from 'bun:test';
import {
  BAR_CHART,
  barExtent,
  barRects,
  GRID_STEPS,
  gridY,
  groupedBarRects,
  secondaryRects,
  zeroY,
} from './bar-chart-view';

const points = (...values: (number | null)[]) =>
  values.map((value, i) => ({ key: `d${i}`, value }));

describe('barExtent', () => {
  test('spans zero to the busiest point, never empty, ignoring a non-finite value', () => {
    expect(barExtent(points(3, 9, 4))).toEqual({ min: 0, max: 9 });
    expect(barExtent(points(0, 0))).toEqual({ min: 0, max: 1 });
    expect(barExtent([])).toEqual({ min: 0, max: 1 });
    expect(barExtent(points(2, Number.NaN, null))).toEqual({ min: 0, max: 2 });
  });

  test('a negative widens it below zero', () => {
    expect(barExtent(points(-5, 10))).toEqual({ min: -5, max: 10 });
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

  test('negative, missing and zero draw three different things', () => {
    // The probe: `[{value:-5},{value:10}]` drew heights [2, 104] — a loss read as a quiet day.
    const rects = barRects(points(-5, null, 0, 10));
    const zero = zeroY(barExtent(points(-5, null, 0, 10)));
    expect(rects[0]?.y).toBeCloseTo(zero);
    expect(rects[0]?.height).toBeGreaterThan(2);
    expect(rects[1]).toBeNull();
    expect(rects[2]?.height).toBe(2);
    expect((rects[2]?.y ?? 0) + (rects[2]?.height ?? 0)).toBeCloseTo(zero);
    expect((rects[3]?.y ?? 0) + (rects[3]?.height ?? 0)).toBeCloseTo(zero);
  });

  test('a non-finite value is a gap, never a bar', () => {
    expect(barRects(points(Number.NaN, 5))[0]).toBeNull();
  });

  test('the zero line sits where the range puts it, the plot floor when nothing is negative', () => {
    expect(zeroY(barExtent(points(1, 2)))).toBe(BAR_CHART.top + BAR_CHART.plot);
    expect(zeroY(barExtent(points(-1, 1)))).toBeCloseTo(BAR_CHART.top + BAR_CHART.plot / 2);
  });

  test('more points than the gaps leave room for still tile the width with positive bars', () => {
    // At 3px a gap, 201 gaps already fill 600px: past that every bar used to be a negative rect.
    for (const count of [201, 202, 300, 1000]) {
      const rects = barRects(points(...Array.from({ length: count }, () => 1)));
      expect(rects.every((rect) => rect !== null && rect.width > 0)).toBe(true);
      const last = rects[count - 1] as { x: number; width: number };
      expect(last.x + last.width).toBeCloseTo(BAR_CHART.width);
    }
  });

  test('no points is no bars', () => {
    expect(barRects([])).toEqual([]);
  });
});

describe('a second series', () => {
  const stacked = (...pairs: [number, number][]) =>
    pairs.map(([value, secondary], i) => ({ key: `d${i}`, value, secondary }));

  test('scales by the stacked total, so the tallest stack fills the plot', () => {
    expect(barExtent(stacked([3, 1], [2, 6])).max).toBe(8);
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

describe('n series', () => {
  test('bars of one key sit side by side, each signed, a gap no bar', () => {
    const rects = groupedBarRects(2, [
      { label: 'a', values: [4, -2] },
      { label: 'b', values: [null, 4] },
    ]);
    expect(rects[1]?.[0]).toBeNull();
    const [a0, a1] = rects[0] ?? [];
    const b1 = rects[1]?.[1];
    expect(a0).not.toBeNull();
    expect((a1?.x ?? 0) + (a1?.width ?? 0)).toBeLessThan(b1?.x ?? 0);
    expect(a1?.y).toBeCloseTo(b1 === null || b1 === undefined ? -1 : b1.y + b1.height);
  });
});
