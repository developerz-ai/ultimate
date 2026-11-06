// The path of a Sparkline, apart from its markup. A sparkline has no axes and no scale to read —
// the shape of the trend is the entire point — so this is one `M`/`L` path per run of known
// points, scaled into the box through zero: a loss sits below it. `null` is a gap, never a zero.

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
  value === null || !Number.isFinite(value) ? null : value;

/** The known range, always through zero and never empty: an all-zero series sits on the floor. */
function extentKnown(points: readonly SparklinePoint[]): readonly [number, number] {
  let lo = 0;
  let hi = 0;
  for (const point of points) {
    const value = known(point.value);
    if (value === null) continue;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  return hi === lo ? [lo, lo + 1] : [lo, hi];
}

const innerHeight = SPARKLINE.height - SPARKLINE.pad * 2;

function yOf(value: number, [lo, hi]: readonly [number, number]): number {
  return SPARKLINE.pad + ((hi - value) / (hi - lo)) * innerHeight;
}

/** The y of zero: the floor of an all-positive series, a line through a signed one. */
export function sparkZeroY(points: readonly SparklinePoint[]): number {
  return yOf(0, extentKnown(points));
}

/**
 * Every point's position in the box, oldest first and index for index; `null` where the value is
 * unknown. A single point sits at the start.
 */
export function sparkPoints(points: readonly SparklinePoint[]): readonly (SparkPoint | null)[] {
  const extent = extentKnown(points);
  const innerWidth = SPARKLINE.width - SPARKLINE.pad * 2;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  return points.map((point, index) => {
    const value = known(point.value);
    if (value === null) return null;
    return {
      x: SPARKLINE.pad + step * index,
      y: yOf(value, extent),
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

/** Each run of two or more known points closed down to zero — the area's `d`; `''` for none. */
export function sparkAreaPath(points: readonly SparklinePoint[]): string {
  const zero = sparkZeroY(points).toFixed(1);
  const runs: SparkPoint[][] = [[]];
  for (const p of sparkPoints(points)) {
    if (p === null) runs.push([]);
    else runs.at(-1)?.push(p);
  }
  return runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const top = run.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const first = run[0] as SparkPoint;
      const last = run.at(-1) as SparkPoint;
      return `M${first.x.toFixed(1)},${zero} ${top} L${last.x.toFixed(1)},${zero} Z`;
    })
    .join(' ');
}
