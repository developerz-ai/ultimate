// The geometry of a BarChart, apart from its markup: where each bar sits, how tall it is, where
// zero and the grid lines fall. Signed: a negative bar hangs below a real zero line, `null` is no
// bar at all, and zero is a 2px stub on the line — three different marks for three facts.

import type { ChartSeries } from './chart-frame-view';
import { finiteOrNull } from './chart-frame-view';

export interface ChartPoint {
  /** The bar's name — a day, a bucket, a label. Read by `<title>` and the axis. */
  readonly key: string;
  /** `null` is unknown: no bar, and the table says so. Never zero-fill a gap. */
  readonly value: number | null;
  /**
   * A second series, stacked on `value` — failed on top of done. Absent or 0 draws nothing, so a
   * one-series chart is exactly the chart it was.
   */
  readonly secondary?: number | undefined;
}

export interface BarRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 600 × 108, nearly 6:1, not 3:1: at dashboard width a taller box pushed the table — the thing
 * people came for — below the fold. `plot` is where bars live; `top` and the matching strip under
 * it only keep the outer grid hairlines off the edge. The axis labels are HTML OUTSIDE the svg
 * (issue 494) — inside a viewBox they scaled with it — so the box spends no strip on them.
 */
export const BAR_CHART = { width: 600, top: 2, plot: 104, height: 108, gap: 3 } as const;

/** Quarter lines. Four is what a reader can use to judge a bar's height without a y-axis. */
export const GRID_STEPS = [0.25, 0.5, 0.75, 1] as const;

/** The shortest mark a known value draws: a zero is still visibly there, unlike a gap. */
const STUB = 2;

/** The value range the plot spans: always through zero, never empty, so it always divides. */
export interface BarExtent {
  readonly min: number;
  readonly max: number;
}

const positive = (value: number | null | undefined): number =>
  Math.max(0, finiteOrNull(value) ?? 0);

/** Folds `also` (reference values) into a range, keeping it non-empty. */
function widened(min: number, max: number, also: readonly number[]): BarExtent {
  const lo = Math.min(min, ...also);
  const hi = Math.max(max, ...also);
  return hi === lo ? { min: lo, max: lo + 1 } : { min: lo, max: hi };
}

/**
 * The lowest and highest point — a stack's whole height — always including zero, and any
 * reference value in `also`, so a target above every bar is still on the plot.
 */
export function barExtent(points: readonly ChartPoint[], also: readonly number[] = []): BarExtent {
  let min = 0;
  let max = 0;
  for (const point of points) {
    const value = finiteOrNull(point.value);
    if (value !== null && value < 0) min = Math.min(min, value);
    max = Math.max(max, positive(value) + positive(point.secondary));
  }
  return widened(min, max, also);
}

/** The same over an n-series chart's every value. */
export function seriesExtent(
  series: readonly ChartSeries[],
  also: readonly number[] = [],
): BarExtent {
  let min = 0;
  let max = 0;
  for (const one of series) {
    for (const raw of one.values) {
      const value = finiteOrNull(raw);
      if (value === null) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return widened(min, max, also);
}

/** The y of `value` in the plot. */
export function valueY(value: number, extent: BarExtent): number {
  return BAR_CHART.top + ((extent.max - value) / (extent.max - extent.min)) * BAR_CHART.plot;
}

/** The y of the zero line — the plot's floor for an all-positive chart. */
export function zeroY(extent: BarExtent): number {
  return valueY(0, extent);
}

/** The y of a grid line at `step` of the plot height (1 = the top line). */
export function gridY(step: number): number {
  return BAR_CHART.top + BAR_CHART.plot - step * BAR_CHART.plot;
}

/** `count` slots across the width: the gap gives way before the bars do, at most half a slot. */
function slots(count: number): { readonly width: number; readonly gap: number } {
  const n = Math.max(count, 1);
  const gap = Math.min(BAR_CHART.gap, BAR_CHART.width / n / 2);
  return { width: (BAR_CHART.width - gap * (n - 1)) / n, gap };
}

/** A bar from zero to `value` at `x`: up for a positive, down for a negative, a stub for zero. */
function barAt(x: number, width: number, value: number, extent: BarExtent): BarRect {
  const zero = zeroY(extent);
  const height = Math.max(STUB, Math.abs(valueY(value, extent) - zero));
  return { x, y: value < 0 ? zero : zero - height, width, height };
}

/** One rect per point, oldest first; `null` where the value is unknown. */
export function barRects(
  points: readonly ChartPoint[],
  extent: BarExtent = barExtent(points),
): readonly (BarRect | null)[] {
  const { width, gap } = slots(points.length);
  return points.map((point, index) => {
    const value = finiteOrNull(point.value);
    return value === null ? null : barAt(index * (width + gap), width, value, extent);
  });
}

/**
 * The second series' rect per point, stacked on the positive part of that point's bar (or on the
 * zero line); `null` where it is 0. Same scale as `barRects`, read against the same grid.
 */
export function secondaryRects(
  points: readonly ChartPoint[],
  extent: BarExtent = barExtent(points),
): readonly (BarRect | null)[] {
  const { width, gap } = slots(points.length);
  return points.map((point, index) => {
    const value = positive(point.secondary);
    if (value === 0) return null;
    const base = valueY(positive(point.value), extent);
    const top = valueY(positive(point.value) + value, extent);
    return { x: index * (width + gap), y: top, width, height: base - top };
  });
}

/**
 * n series over shared keys, side by side within each key's slot — every bar signed on its own,
 * so a negative in one series never hides another. `[series][key]`, `null` for a gap.
 */
export function groupedBarRects(
  keyCount: number,
  series: readonly ChartSeries[],
  extent: BarExtent = seriesExtent(series),
): readonly (readonly (BarRect | null)[])[] {
  const slot = slots(keyCount);
  const inner = Math.min(1, slot.width / Math.max(series.length, 1) / 4);
  const width = (slot.width - inner * (series.length - 1)) / Math.max(series.length, 1);
  return series.map((one, s) =>
    Array.from({ length: keyCount }, (_, k) => {
      const value = finiteOrNull(one.values[k]);
      const x = k * (slot.width + slot.gap) + s * (width + inner);
      return value === null ? null : barAt(x, width, value, extent);
    }),
  );
}
