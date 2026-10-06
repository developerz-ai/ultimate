import { describe, expect, test } from 'bun:test';
import {
  LINE_CHART,
  lineLayout,
  MARKERS_ON_EVERY_POINT_UP_TO,
  markedPoints,
} from './line-chart-view';

const { width, height, pad } = LINE_CHART;
const layoutOf = (values: readonly (number | null)[][], zero = true) =>
  lineLayout({
    keys: (values[0] ?? []).map((_, i) => `k${i}`),
    series: values.map((v, i) => ({ label: `s${i}`, values: v })),
    zero,
    maxTicks: 6,
  });

describe('lineLayout — the scale', () => {
  test('the value axis is the nice scale over every series, from zero by default', () => {
    const layout = layoutOf([
      [1, 4, 9],
      [2, 3, 3],
    ]);
    expect(layout.scale.ticks).toEqual([0, 2, 4, 6, 8, 10]);
    // The top tick is the top of the plot and the bottom tick its floor.
    expect(layout.ticks.at(-1)?.y).toBe(pad);
    expect(layout.ticks[0]?.y).toBe(height - pad);
  });

  test('integer data is detected, and gets whole ticks with the max labelled', () => {
    const layout = layoutOf([[0, 1, 2]]);
    expect(layout.scale.ticks).toEqual([0, 1, 2]);
    expect(layout.scale.ticks.at(-1)).toBe(2);
    // One fractional value anywhere and the axis may divide again.
    expect(layoutOf([[0, 1, 2.5]]).scale.ticks.every(Number.isInteger)).toBe(false);
  });

  test('zero: false fits the data, for a series that lives far from zero', () => {
    const layout = layoutOf([[200, 210, 230]], false);
    expect(layout.scale.min).toBeGreaterThan(0);
    expect(layout.scale.min).toBeLessThanOrEqual(200);
    expect(layout.scale.max).toBeGreaterThanOrEqual(230);
  });

  test('a negative value extends the axis below zero and the baseline sits on zero', () => {
    const layout = layoutOf([[-4, 6]]);
    expect(layout.scale.min).toBeLessThan(0);
    const zeroTick = layout.ticks.find((tick) => tick.value === 0);
    expect(layout.baselineY).toBe(zeroTick?.y as number);
  });

  test('no data at all is a 0..1 axis, never a division by zero', () => {
    const layout = layoutOf([[null, null]]);
    expect(layout.scale.min).toBe(0);
    expect(layout.scale.max).toBe(1);
    expect(layout.series[0]?.line).toBe('');
  });
});

describe('lineLayout — the paths', () => {
  test('points span the plot edge to edge, oldest at the start', () => {
    const points = layoutOf([[0, 5, 10]]).series[0]?.points ?? [];
    expect(points.map((p) => p.x)).toEqual([pad, width / 2, width - pad]);
    expect(points[0]?.y).toBe(height - pad);
    expect(points[2]?.y).toBe(pad);
  });

  test('a null is a GAP: the line lifts and resumes, it never dives to zero', () => {
    const series = layoutOf([[1, null, 3, 4]]).series[0];
    expect(series?.points.map((p) => p.index)).toEqual([0, 2, 3]);
    expect(series?.line.match(/M/g)).toHaveLength(2);
    expect(series?.line).not.toContain('NaN');
  });

  test('the area closes each run down to the baseline', () => {
    const layout = layoutOf([[2, 4]]);
    const area = layout.series[0]?.area ?? '';
    expect(area.startsWith(`M${pad},${layout.baselineY}`)).toBe(true);
    expect(area).toEndWith(`L${width - pad},${layout.baselineY} Z`);
  });

  test('a run of one point has no area to fill and draws no line segment', () => {
    const series = layoutOf([[3, null, null]]).series[0];
    expect(series?.area).toBe('');
    expect(series?.line).toMatch(/^M[\d.]+,[\d.]+$/);
  });

  test('every key has an x, a gap included, so its axis label still lands under it', () => {
    const layout = layoutOf([[1, null, 3]]);
    expect(layout.keyX).toEqual([pad, width / 2, width - pad]);
  });

  test('one key sits in the middle, not pinned to the start edge', () => {
    expect(layoutOf([[7]]).series[0]?.points[0]?.x).toBe(width / 2);
  });

  test('values past the keys are ignored — every point comes from a key', () => {
    const layout = lineLayout({
      keys: ['a'],
      series: [{ label: 's', values: [1, 99] }],
      zero: true,
      maxTicks: 6,
    });
    expect(layout.series[0]?.points).toHaveLength(1);
    expect(layout.scale.max).toBeLessThan(99);
  });
});

describe('markedPoints', () => {
  test(`every point carries its marker up to ${MARKERS_ON_EVERY_POINT_UP_TO} keys`, () => {
    const points = layoutOf([[1, 2, 3]]).series[0]?.points ?? [];
    expect(markedPoints(points, 3)).toHaveLength(3);
  });

  test('a dense series marks only its newest point, so the markers do not become the line', () => {
    const values = Array.from({ length: MARKERS_ON_EVERY_POINT_UP_TO + 1 }, (_, i) => i);
    const points = layoutOf([values]).series[0]?.points ?? [];
    const marked = markedPoints(points, values.length);
    expect(marked.map((p) => p.index)).toEqual([values.length - 1]);
  });
});
