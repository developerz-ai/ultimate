// The geometry of a LineChart / AreaChart, apart from its markup: the nice value scale over every
// series, each point's position, the line through each unbroken run and the area under it. Pure,
// so a server render and an island draw one chart; `null` is a gap, never a dive to zero.

import type { ChartSeries } from './chart-frame-view';
import { finiteOrNull } from './chart-frame-view';
import type { NiceScale } from './chart-ticks-view';
import { niceTicks } from './chart-ticks-view';

/**
 * 600 × 200, 3:1 — a dashboard row, not a hero. `pad` keeps a marker on the outermost point (and
 * a stroke on the top grid line) inside the box. Labels are HTML outside the svg, like BarChart's
 * (issue 494): inside a viewBox they would scale with it.
 */
export const LINE_CHART = { width: 600, height: 200, pad: 8 } as const;

/** Past this many keys a marker per point is a second, lumpier line; only the newest is marked. */
export const MARKERS_ON_EVERY_POINT_UP_TO = 24;

export interface LinePoint {
  /** The key's index — a gap skips an index, so this is not the point's position in the array. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

export interface LineSeriesGeometry {
  readonly points: readonly LinePoint[];
  /** `M … L …`, one `M` per unbroken run; `''` for a series with no value. */
  readonly line: string;
  /** Each run of two or more points closed down to the baseline; `''` when there is none. */
  readonly area: string;
}

export interface LineTick {
  readonly value: number;
  readonly y: number;
}

export interface LineLayout {
  readonly scale: NiceScale;
  readonly ticks: readonly LineTick[];
  /** The y of zero — or of the axis edge nearest it, for a range that does not cross zero. */
  readonly baselineY: number;
  /** The x of every key, gap or not — where its axis label sits. */
  readonly keyX: readonly number[];
  readonly series: readonly LineSeriesGeometry[];
}

export interface LineLayoutInput {
  readonly keys: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Start the axis at zero (the honest default for counts) or fit it to the data. */
  readonly zero: boolean;
  readonly maxTicks: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * Every drawn value is a whole number — a count. Detected rather than asked for: a prop is one
 * more thing a caller forgets, and the data already says it. One fraction anywhere turns it off.
 */
function allIntegers(input: LineLayoutInput): boolean {
  return input.series.every((series) =>
    input.keys.every((_, i) => {
      const value = finiteOrNull(series.values[i]);
      return value === null || Number.isInteger(value);
    }),
  );
}

function extent(input: LineLayoutInput): readonly [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const series of input.series) {
    for (let i = 0; i < input.keys.length; i += 1) {
      const value = finiteOrNull(series.values[i]);
      if (value === null) continue;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
  }
  if (lo > hi) return [0, 1];
  return input.zero ? [Math.min(0, lo), Math.max(0, hi)] : [lo, hi];
}

function runsOf(points: readonly LinePoint[]): LinePoint[][] {
  const runs: LinePoint[][] = [];
  let previous = -2;
  for (const point of points) {
    if (point.index !== previous + 1 || runs.length === 0) runs.push([]);
    runs.at(-1)?.push(point);
    previous = point.index;
  }
  return runs;
}

const at = (point: LinePoint): string => `${point.x},${point.y}`;

export function lineLayout(input: LineLayoutInput): LineLayout {
  const [lo, hi] = extent(input);
  const scale = niceTicks(lo, hi, input.maxTicks, { integer: allIntegers(input) });
  const { width, height, pad } = LINE_CHART;
  // Halved on both sides, which leaves the ratio exact (a power-of-two scale commutes with
  // rounding): `max - min` over the full float64 range overflows to Infinity, and the bottom
  // tick's `Infinity / Infinity` drew `y="NaN"`.
  const half = scale.max / 2 - scale.min / 2;
  const yOf = (value: number): number =>
    round(pad + ((scale.max / 2 - value / 2) / half) * (height - pad * 2));
  const count = input.keys.length;
  const xOf = (index: number): number =>
    count <= 1 ? width / 2 : round(pad + (index * (width - pad * 2)) / (count - 1));
  const baselineY = yOf(Math.min(scale.max, Math.max(scale.min, 0)));

  const series = input.series.map((one): LineSeriesGeometry => {
    const points: LinePoint[] = [];
    for (let index = 0; index < count; index += 1) {
      const value = finiteOrNull(one.values[index]);
      if (value !== null) points.push({ index, x: xOf(index), y: yOf(value), value });
    }
    const runs = runsOf(points);
    const line = runs
      .map((run) => run.map((point, i) => `${i === 0 ? 'M' : 'L'}${at(point)}`).join(' '))
      .join(' ');
    const area = runs
      .filter((run) => run.length > 1)
      .map((run) => {
        const first = run[0] as LinePoint;
        const last = run.at(-1) as LinePoint;
        const top = run.map((point) => `L${at(point)}`).join(' ');
        return `M${first.x},${baselineY} ${top} L${last.x},${baselineY} Z`;
      })
      .join(' ');
    return { points, line, area };
  });

  return {
    scale,
    ticks: scale.ticks.map((value) => ({ value, y: yOf(value) })),
    baselineY,
    keyX: input.keys.map((_, index) => xOf(index)),
    series,
  };
}

/** The points that carry a marker: all of them on a short series, only the newest on a dense one. */
export function markedPoints(points: readonly LinePoint[], keyCount: number): readonly LinePoint[] {
  if (keyCount <= MARKERS_ON_EVERY_POINT_UP_TO) return points;
  const last = points.at(-1);
  return last === undefined ? [] : [last];
}
