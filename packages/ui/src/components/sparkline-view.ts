// The path of a Sparkline, apart from its markup. A sparkline has no axes and no scale to read —
// the shape of the trend is the entire point — so this is one `M`/`L` path per run of known
// points, scaled into the box. `null` is a gap, never a dive to zero, as `LineChart` holds it.

/** 600 × 72: stretched to a content column, 240 × 48 came out ~220px tall — a chart, not a sparkline. */
export const SPARKLINE = { width: 600, height: 72, pad: 4 } as const;

/** One value of the series; `null` is unknown — a gap in the line, not a zero. */
export interface SparklinePoint {
  readonly key: string;
  readonly value: number | null;
}

export interface SparkPoint {
  readonly x: number;
  readonly y: number;
}

const known = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.max(0, value);

/** The busiest known value, at least 1, so an all-zero series sits on the baseline. */
function maxKnown(points: readonly SparklinePoint[]): number {
  let max = 1;
  for (const point of points) max = Math.max(max, known(point.value) ?? 0);
  return max;
}

/**
 * Every point's position in the box, oldest first and index for index; `null` where the value is
 * unknown. A single point sits at the start.
 */
export function sparkPoints(points: readonly SparklinePoint[]): readonly (SparkPoint | null)[] {
  const max = maxKnown(points);
  const innerWidth = SPARKLINE.width - SPARKLINE.pad * 2;
  const innerHeight = SPARKLINE.height - SPARKLINE.pad * 2;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  return points.map((point, index) => {
    const value = known(point.value);
    if (value === null) return null;
    return {
      x: SPARKLINE.pad + step * index,
      y: SPARKLINE.pad + innerHeight - (value / max) * innerHeight,
    };
  });
}

/** The `d` attribute, one decimal per coordinate — stable across renders. Empty for no points. */
export function sparklinePath(points: readonly SparklinePoint[]): string {
  let fresh = true;
  const parts: string[] = [];
  for (const p of sparkPoints(points)) {
    if (p === null) {
      fresh = true;
      continue;
    }
    parts.push(`${fresh ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    fresh = false;
  }
  return parts.join(' ');
}
