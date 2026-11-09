// The trend chip on a StatTile, as a pure rule: a percentage against a baseline — or the signed
// difference, from zero or under a baseline too small for a percentage to mean anything — and
// whether that direction is good, which is the caller's to say: an error rate rising is not green.

export type StatTrend = 'up' | 'down' | 'flat';

/** Which direction is good news. `none`: neither — the arrow says which way, no colour says how. */
export type StatGoodWhen = 'up' | 'down' | 'none';

/** What colour a chip earns: `good`, `bad`, or `neutral` when no direction was called good. */
export type StatMood = 'good' | 'bad' | 'neutral';

export interface StatDelta {
  /** Already formatted: "+12%", "−4%", "0%", or a difference: "+5". */
  readonly text: string;
  readonly trend: StatTrend;
}

export interface DeltaOptions {
  /**
   * Below this baseline (absolute), the chip is the signed difference, not a percentage: 2 → 5 is
   * "+3", never "+150%". A zero baseline always gives the difference.
   */
  readonly absoluteBelow?: number | undefined;
  /** Formats a difference's magnitude. Default: up to two decimals, no grouping. */
  readonly format?: ((magnitude: number) => string) | undefined;
}

/** U+2212, the real minus: it is the width of `+`, so the chip does not jump between states. */
const MINUS = '−';

const plain = (magnitude: number): string => String(Math.round(magnitude * 100) / 100);

function signed(diff: number, text: string): StatDelta {
  if (diff === 0) return { text, trend: 'flat' };
  return diff > 0 ? { text: `+${text}`, trend: 'up' } : { text: `${MINUS}${text}`, trend: 'down' };
}

/**
 * The chip for `current` against `baseline`. A percentage, rounded to a whole percent — a tile is a
 * glance, not a ledger — unless the baseline is zero, negative or under `absoluteBelow`, where a
 * percentage is a number that means nothing and the signed difference is said instead.
 */
export function deltaOf(
  current: number,
  baseline: number,
  options: DeltaOptions = {},
): StatDelta | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return undefined;
  const below = options.absoluteBelow;
  const absolute =
    baseline <= 0 || (below !== undefined && Number.isFinite(below) && Math.abs(baseline) < below);
  if (absolute) {
    const diff = current - baseline;
    const text = (options.format ?? plain)(Math.abs(diff));
    return diff === 0 ? { text: '0', trend: 'flat' } : signed(diff, text);
  }
  const pct = Math.round(((current - baseline) / baseline) * 100);
  return pct === 0 ? { text: '0%', trend: 'flat' } : signed(pct, `${Math.abs(pct)}%`);
}

/** Whether a trend is good news, by the caller's word for it. Flat is never coloured. */
export function deltaMood(trend: StatTrend, goodWhen: StatGoodWhen): StatMood {
  if (trend === 'flat' || goodWhen === 'none') return 'neutral';
  return trend === goodWhen ? 'good' : 'bad';
}

/** Drawn, not typed: an arrow character inherits the font's metrics and sits off-centre in a pill. */
export const DELTA_ARROW_PATH: Readonly<Record<StatTrend, string>> = {
  up: 'M2 7 L5 3 L8 7',
  down: 'M2 3 L5 7 L8 3',
  flat: 'M2 5 L8 5',
};
