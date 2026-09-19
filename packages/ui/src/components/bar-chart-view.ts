// The geometry of a BarChart, apart from its markup: where each bar sits, how tall it is, where
// the grid lines fall. Pure, so the server render and a hydrated one cannot draw two charts.

export interface ChartPoint {
  /** The bar's name — a day, a bucket, a label. Read by `<title>` and the axis. */
  readonly key: string;
  readonly value: number;
}

export interface BarRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 600 × 128 at a 5:1-ish ratio, not 3:1: at dashboard width a taller box pushed the table — the
 * thing people came for — below the fold. `plot` is where bars live; the strip under it belongs
 * to the axis labels, which drawn ON the first and last bars were unreadable there.
 */
export const BAR_CHART = { width: 600, top: 12, plot: 104, height: 128, gap: 3 } as const;

/** Quarter lines. Four is what a reader can use to judge a bar's height without a y-axis. */
export const GRID_STEPS = [0.25, 0.5, 0.75, 1] as const;

/** The busiest point, and never below 1, so an all-zero series still divides. */
export function maxOf(points: readonly ChartPoint[]): number {
  let max = 1;
  for (const point of points)
    if (Number.isFinite(point.value) && point.value > max) max = point.value;
  return max;
}

/** The y of a grid line at `step` of the plot height (1 = the top line = the busiest point). */
export function gridY(step: number): number {
  return BAR_CHART.top + BAR_CHART.plot - step * BAR_CHART.plot;
}

/** One rect per point, oldest first. At least 2px tall so a zero still draws a visible bar. */
export function barRects(points: readonly ChartPoint[]): readonly BarRect[] {
  const count = Math.max(points.length, 1);
  const width = (BAR_CHART.width - BAR_CHART.gap * (count - 1)) / count;
  const max = maxOf(points);
  return points.map((point, index) => {
    const value = Number.isFinite(point.value) ? Math.max(0, point.value) : 0;
    const height = Math.max(2, (value / max) * BAR_CHART.plot);
    return {
      x: index * (width + BAR_CHART.gap),
      y: BAR_CHART.top + BAR_CHART.plot - height,
      width,
      height,
    };
  });
}
