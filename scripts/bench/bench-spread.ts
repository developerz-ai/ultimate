// Min and median of repeated runs, per named figure: what a published bench number is, so one lucky
// or unlucky run is never the figure. A run that failed contributes nothing, and says so in `n`.

export interface Spread {
  readonly min: number;
  readonly median: number;
  /** How many runs measured this figure. */
  readonly n: number;
}

/** Lower median: an even count reports the smaller middle value, never an average nobody measured. */
export function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    n: sorted.length,
  };
}

/** Each figure's spread across `runs`, skipping a `null` (a step that failed or never ran). */
export function spreads(
  runs: readonly Readonly<Record<string, number | null>>[],
): Readonly<Record<string, Spread | null>> {
  const names = [...new Set(runs.flatMap((run) => Object.keys(run)))];
  return Object.fromEntries(
    names.map((name) => [
      name,
      spreadOf(runs.flatMap((run) => (typeof run[name] === 'number' ? [run[name]] : []))),
    ]),
  );
}
