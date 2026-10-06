// Axis arithmetic shared by every chart with a value axis: a "nice" scale (steps of 1, 2 or 5 ×
// 10ⁿ, the only steps a reader can count in their head) and which category keys get a label.
// Pure, so the server render and an island draw the same axis, and testable with no renderer.

export interface NiceScale {
  /** The axis' lowest tick — at or below the data's minimum. */
  readonly min: number;
  /** The axis' highest tick — at or above the data's maximum. */
  readonly max: number;
  readonly step: number;
  /** `min`, `min + step`, … `max`, as exact decimals. */
  readonly ticks: readonly number[];
}

const MANTISSAS = [1, 2, 5] as const;

/** Rounds away binary noise: `0.1 + 0.2` is drawn as `0.3`, never `0.30000000000000004`. */
const exact = (value: number): number => Number(value.toPrecision(12));

/** The largest step of the 1-2-5 ladder at or below `raw`; 1 for a raw step that is not one. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const power = 10 ** exp;
  const fraction = raw / power;
  let mantissa = 1;
  for (const candidate of MANTISSAS) if (candidate <= fraction * (1 + 1e-9)) mantissa = candidate;
  return exact(mantissa * power);
}

/** The next rung of the ladder above `step`: 1 → 2 → 5 → 10 → 20. */
function nextStep(step: number): number {
  const exp = Math.floor(Math.log10(step));
  const mantissa = Math.round(step / 10 ** exp);
  if (mantissa === 1) return exact(2 * 10 ** exp);
  if (mantissa === 2) return exact(5 * 10 ** exp);
  return exact(10 ** (exp + 1));
}

/** Fraction digits a tick at `step` needs: 0 for 5 or 500, 1 for 0.5, 2 for 0.02. */
export function tickDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

/** A flat range has no height to divide: open it by a tenth of its size (or by 1 at zero). */
function bounds(lo: number, hi: number): readonly [number, number] {
  const a = Number.isFinite(lo) ? lo : 0;
  const b = Number.isFinite(hi) ? hi : a;
  const [low, high] = a <= b ? [a, b] : [b, a];
  if (high > low) return [low, high];
  if (low === 0) return [0, 1];
  const open = Math.abs(low) * 0.1;
  return [low - open, high + open];
}

export interface NiceTicksOptions {
  /**
   * The data is whole numbers — a count. Steps are then at least 1, so no tick falls between two
   * values the data can take: "0.4 signups" labels nothing, and it pushed the max off the labels.
   */
  readonly integer?: boolean | undefined;
}

/**
 * The densest 1-2-5 labelling of `lo..hi` with at most `maxTicks` ticks (read as at least 2):
 * start at the step that would fit exactly and climb the ladder until the count fits.
 */
export function niceTicks(
  lo: number,
  hi: number,
  maxTicks = 6,
  options: NiceTicksOptions = {},
): NiceScale {
  const cap = Math.max(2, Math.floor(maxTicks));
  const [low, high] = bounds(lo, hi);
  const fitted = niceStep((high - low) / (cap - 1));
  // Every rung of the ladder from 1 up is a whole number, so flooring the START at 1 is enough.
  let step = options.integer === true ? Math.max(1, fitted) : fitted;
  for (;;) {
    const min = exact(Math.floor(low / step + 1e-9) * step);
    const max = exact(Math.ceil(high / step - 1e-9) * step);
    const count = Math.round((max - min) / step) + 1;
    if (count <= cap) {
      const ticks = Array.from({ length: count }, (_, i) => exact(min + i * step));
      return { min, max, step, ticks };
    }
    step = nextStep(step);
  }
}

/**
 * Which of `count` category keys carry a label, at most `max` of them: an even stride counted
 * back from the NEWEST key, which is always labelled — on a time axis it is the one people read.
 * The stride is at least `(count - 1) / (max - 1)` keys, which is what lets a label be capped at
 * a fixed share of the axis and never touch its neighbour.
 */
export function axisLabelIndices(count: number, max: number): readonly number[] {
  if (count <= 0) return [];
  const cap = Math.max(2, Math.floor(max));
  if (count <= cap) return Array.from({ length: count }, (_, i) => i);
  const stride = Math.ceil((count - 1) / (cap - 1));
  const out: number[] = [];
  for (let index = count - 1; index >= 0; index -= stride) out.unshift(index);
  return out;
}

/** Category labels a chart under its container breakpoint shows — a 390px phone. */
export const NARROW_LABELS = 3;
/** And at or above it. Each label is capped at ⅔ of the narrowest stride, so neither overlaps. */
export const WIDE_LABELS = 6;

export type LabelEdge = 'start' | 'middle' | 'end';

export interface CategoryLabel {
  readonly index: number;
  /** Shown below the container breakpoint (`data-narrow`). */
  readonly narrow: boolean;
  /** Shown at or above it (`data-wide`). */
  readonly wide: boolean;
  /** The oldest key aligns to the start edge, the newest to the end, so neither leaves the box. */
  readonly edge: LabelEdge;
}

/**
 * Every key that either width labels, oldest first, each flagged with the width that shows it.
 * The sheet hides by flag, so one server render serves the phone and the desktop with no JS.
 */
export function categoryLabels(count: number): readonly CategoryLabel[] {
  const narrow = new Set(axisLabelIndices(count, NARROW_LABELS));
  const wide = new Set(axisLabelIndices(count, WIDE_LABELS));
  const indices = [...new Set([...narrow, ...wide])].sort((a, b) => a - b);
  return indices.map((index) => ({
    index,
    narrow: narrow.has(index),
    wide: wide.has(index),
    edge: count === 1 ? 'middle' : index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
  }));
}

/**
 * Which of `count` value-axis labels a narrow chart hides: every other one counted down from the
 * TOP, once there are more than three — the highest tick is the one that bounds the data, so it is
 * never the one dropped. Hidden labels keep their grid line; only the text goes.
 */
export function minorTicks(count: number): readonly boolean[] {
  return Array.from({ length: count }, (_, i) => count > 3 && (count - 1 - i) % 2 === 1);
}
