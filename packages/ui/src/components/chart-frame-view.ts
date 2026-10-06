// What every chart shares apart from its geometry: which colour slot, dash and marker a series
// gets (so no series is told apart by colour alone), the data table a screen reader and a
// no-colour reader get instead of the picture, and how a number becomes text — always in a locale
// the caller passed, never the runtime's default.

/** The chart colour roles, `chart-1` … `chart-8` (`--color-chart-N`). */
export const CHART_SERIES_SLOTS = 8;

export type MarkerShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'plus'
  | 'triangle-down'
  | 'cross'
  | 'star';

const MARKERS: readonly MarkerShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'plus',
  'triangle-down',
  'cross',
  'star',
];

/**
 * Five dash patterns against eight slots and markers: 5 and 8 share no factor, so the whole look
 * of a series (slot, dash, marker) first repeats at the 41st — a ninth series reuses a colour,
 * never a line. Units are screen px: every chart stroke is `non-scaling-stroke`.
 */
const DASHES: readonly (string | undefined)[] = [undefined, '6 4', '2 3', '10 3 2 3', '1 4'];

export interface SeriesStyle {
  /** 1-based: the `N` of `--color-chart-N`, and the `data-series` a sheet keys the colour on. */
  readonly slot: number;
  /** `stroke-dasharray`; `undefined` is a solid line. */
  readonly dash: string | undefined;
  readonly marker: MarkerShape;
}

const indexOf = (index: number): number =>
  Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;

/** The look of the `index`th series (0-based). */
export function seriesStyle(index: number): SeriesStyle {
  const i = indexOf(index);
  return {
    slot: (i % CHART_SERIES_SLOTS) + 1,
    dash: DASHES[i % DASHES.length],
    marker: MARKERS[i % MARKERS.length] ?? 'circle',
  };
}

/** A coordinate as SVG text: two decimals at most, no trailing zeros, never `-0`. */
export function svgNumber(value: number): string {
  const text = value.toFixed(2).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** A closed polygon through `points` (unit offsets scaled by `r` around `x, y`). */
function polygon(x: number, y: number, r: number, points: readonly (readonly [number, number])[]) {
  const [head, ...rest] = points.map(
    ([dx, dy]) => `${svgNumber(x + dx * r)},${svgNumber(y + dy * r)}`,
  );
  return `M${head} ${rest.map((p) => `L${p}`).join(' ')} Z`;
}

const ring = (count: number, radius: number, phase = 0): [number, number][] =>
  Array.from({ length: count }, (_, i) => {
    const angle = phase + (i * 2 * Math.PI) / count;
    return [Math.sin(angle) * radius, -Math.cos(angle) * radius];
  });

/** Polygons only, so a marker is one path a sheet fills — a 12-gon IS a circle at 4px. */
const SHAPES: Record<MarkerShape, readonly (readonly [number, number])[]> = {
  circle: ring(12, 1),
  square: [
    [-0.85, -0.85],
    [0.85, -0.85],
    [0.85, 0.85],
    [-0.85, 0.85],
  ],
  triangle: [
    [0, -1],
    [1, 0.85],
    [-1, 0.85],
  ],
  diamond: [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ],
  plus: [
    [-0.33, -1],
    [0.33, -1],
    [0.33, -0.33],
    [1, -0.33],
    [1, 0.33],
    [0.33, 0.33],
    [0.33, 1],
    [-0.33, 1],
    [-0.33, 0.33],
    [-1, 0.33],
    [-1, -0.33],
    [-0.33, -0.33],
  ],
  'triangle-down': [
    [-1, -0.85],
    [1, -0.85],
    [0, 1],
  ],
  cross: [
    [-1, -0.6],
    [-0.6, -1],
    [0, -0.4],
    [0.6, -1],
    [1, -0.6],
    [0.4, 0],
    [1, 0.6],
    [0.6, 1],
    [0, 0.4],
    [-0.6, 1],
    [-1, 0.6],
    [-0.4, 0],
  ],
  star: ring(10, 1).map(([dx, dy], i) => (i % 2 === 0 ? [dx, dy] : [dx * 0.45, dy * 0.45])),
};

/** The `d` of a marker of `shape` centred on `x, y`, inside a box of half-width `r`. */
export function markerPath(shape: MarkerShape, x: number, y: number, r: number): string {
  return polygon(x, y, r, SHAPES[shape]);
}

/** A value a chart can place, or `null` for a gap: missing, NaN and ±∞ are never drawn as 0. */
export function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ChartSeries {
  /** The series' name, already translated: the legend entry and the table's column head. */
  readonly label: string;
  /** One value per key, in key order; `null` is a gap in the line and an empty table cell. */
  readonly values: readonly (number | null)[];
}

export interface ChartTableRow {
  readonly key: string;
  readonly cells: readonly string[];
}

export interface ChartTable {
  readonly caption: string;
  /** The corner cell (the key column's head, `''` when unnamed), then one head per series. */
  readonly head: readonly string[];
  readonly rows: readonly ChartTableRow[];
}

export interface ChartTableInput {
  readonly caption: string;
  readonly keyLabel: string | undefined;
  readonly keys: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly format: (value: number) => string;
}

/** The same numbers the picture draws, as rows a screen reader walks cell by cell. */
export function chartTable(input: ChartTableInput): ChartTable {
  return {
    caption: input.caption,
    head: [input.keyLabel ?? '', ...input.series.map((series) => series.label)],
    rows: input.keys.map((key, index) => ({
      key,
      cells: input.series.map((series) => {
        const value = finiteOrNull(series.values[index]);
        return value === null ? '' : input.format(value);
      }),
    })),
  };
}

/** `Intl.NumberFormat` in the locale passed — the page's, read by the component from `useUi()`. */
export function chartNumberFormat(
  locale: string,
  maxFractionDigits = 2,
): (value: number) => string {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits });
  return (value) => format.format(value);
}

/** A point's accessible name: key, series (when there is more than one thing to name), value. */
export function pointLabel(key: string, series: string | undefined, value: string): string {
  return series === undefined ? `${key}: ${value}` : `${key}, ${series}: ${value}`;
}

/** `part` of `whole` as a CSS percentage for a `--x`/`--y` custom property, clamped to the box. */
export function cssPercent(part: number, whole: number): string {
  if (!(whole > 0) || !Number.isFinite(part)) return '0%';
  const share = Math.min(1, Math.max(0, part / whole));
  return `${svgNumber(share * 100)}%`;
}

/** A share (0..1) as a percentage in the locale passed: a donut's legend, a gauge's readout. */
export function chartPercentFormat(locale: string): (share: number) => string {
  const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return (share) => format.format(share);
}

/** Which way a point's readout opens: inward from the outer fifth of the plot, centred elsewhere. */
export function hitEdge(x: number, width: number): 'start' | 'middle' | 'end' {
  const share = width > 0 ? x / width : 0.5;
  if (share < 0.2) return 'start';
  if (share > 0.8) return 'end';
  return 'middle';
}
