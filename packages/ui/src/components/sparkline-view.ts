// The path of a Sparkline, apart from its markup. A sparkline has no axes and no scale to read —
// the shape of the trend is the entire point — so this is one `M`/`L` path through every point,
// scaled into the box. Pure, so two renders draw one line.

import type { ChartPoint } from './bar-chart-view';
import { maxOf } from './bar-chart-view';

/** 600 × 72: stretched to a content column, 240 × 48 came out ~220px tall — a chart, not a sparkline. */
export const SPARKLINE = { width: 600, height: 72, pad: 4 } as const;

export interface SparkPoint {
  readonly x: number;
  readonly y: number;
}

/** Every point's position in the box, oldest first; a single point sits at the start. */
export function sparkPoints(points: readonly ChartPoint[]): readonly SparkPoint[] {
  const max = maxOf(points);
  const innerWidth = SPARKLINE.width - SPARKLINE.pad * 2;
  const innerHeight = SPARKLINE.height - SPARKLINE.pad * 2;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  return points.map((point, index) => {
    const value = Number.isFinite(point.value) ? Math.max(0, point.value) : 0;
    return {
      x: SPARKLINE.pad + step * index,
      y: SPARKLINE.pad + innerHeight - (value / max) * innerHeight,
    };
  });
}

/** The `d` attribute, one decimal per coordinate — stable across renders. Empty for no points. */
export function sparklinePath(points: readonly ChartPoint[]): string {
  return sparkPoints(points)
    .map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
}
