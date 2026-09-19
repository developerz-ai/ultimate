// The trend chip on a StatTile, as a pure rule: a percentage against a baseline, or nothing at
// all when the baseline is zero — a percentage of nothing is a number that means nothing.

export type StatTrend = 'up' | 'down' | 'flat';

export interface StatDelta {
  /** Already formatted: "+12%", "−4%", "0%". */
  readonly text: string;
  readonly trend: StatTrend;
}

/**
 * U+2212, the real minus: it is the width of `+`, so the chip does not jump between states.
 * Rounded to a whole percent — a tile is a glance, not a ledger.
 */
export function deltaOf(current: number, baseline: number): StatDelta | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return undefined;
  const pct = Math.round(((current - baseline) / baseline) * 100);
  if (pct === 0) return { text: '0%', trend: 'flat' };
  return pct > 0
    ? { text: `+${pct}%`, trend: 'up' }
    : { text: `−${Math.abs(pct)}%`, trend: 'down' };
}

/** Drawn, not typed: an arrow character inherits the font's metrics and sits off-centre in a pill. */
export const DELTA_ARROW_PATH: Readonly<Record<StatTrend, string>> = {
  up: 'M2 7 L5 3 L8 7',
  down: 'M2 3 L5 7 L8 3',
  flat: 'M2 5 L8 5',
};
