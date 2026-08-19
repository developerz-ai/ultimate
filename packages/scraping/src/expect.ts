// The silent-green alarm. The worst failure a scraper has is not a crash — it is a run that
// succeeds, returns nothing, writes nothing, alerts nobody, and stays green until somebody asks
// where the data went. `expect` turns that into a red run: a yield under `minRows`, or under
// `maxDrop` of what this scrape normally returns, throws.

import { yieldCollapsed } from './error-throws';
import type { ScrapeError } from './errors';

export interface YieldExpectation {
  /**
   * The floor, in rows. A scrape whose real answer is legitimately sometimes zero declares
   * `minRows: 0` — explicitly, so the reader can tell "zero is fine here" from "nobody thought
   * about it". Omitted means only `maxDrop` applies.
   */
  readonly minRows?: number | undefined;
  /**
   * How far below the trailing median a run may fall, as a fraction: `0.5` allows half. The
   * comparison is against the MEDIAN and not the mean because one 12,000-row backfill run in the
   * history would drag a mean high enough to fire the alarm on every ordinary day afterwards.
   */
  readonly maxDrop?: number | undefined;
  /** How many past runs form the baseline. */
  readonly window?: number | undefined;
}

export const DEFAULT_YIELD_WINDOW = 7;

/**
 * Below this many samples there is no baseline, so `maxDrop` cannot fire. A median of one run
 * would make the SECOND run of a brand-new scraper alarm on any variation at all, and an alarm
 * that fires on day two of every new scraper is an alarm somebody turns off.
 */
export const MIN_BASELINE_RUNS = 3;

/** What a run's yield is measured against. Persisted by the app, never by this package. */
export interface YieldHistory {
  /** Most recent first or last — order is irrelevant to a median, and this says so. */
  recent(scrape: string, limit: number): Promise<readonly number[]>;
  record(scrape: string, rows: number): Promise<void>;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (high === undefined) return undefined;
  return sorted.length % 2 === 1 ? high : ((low ?? high) + high) / 2;
}

export interface YieldCheck {
  readonly scrape: string;
  readonly rows: number;
  readonly expect: YieldExpectation;
  readonly history: readonly number[];
}

/**
 * The whole rule, pure: the error this yield earns, or `undefined`. Pure so a test can hand it
 * fifty histories without a queue, a browser or a clock.
 */
export function yieldProblem(check: YieldCheck): ScrapeError | undefined {
  const { minRows, maxDrop } = check.expect;
  if (minRows !== undefined && check.rows < minRows) {
    return yieldCollapsed({ scrape: check.scrape, rows: check.rows, reason: 'min-rows', minRows });
  }
  if (maxDrop === undefined || check.history.length < MIN_BASELINE_RUNS) return undefined;
  const baseline = median(check.history);
  if (baseline === undefined || baseline <= 0) return undefined;
  if (check.rows >= baseline * (1 - maxDrop)) return undefined;
  return yieldCollapsed({
    scrape: check.scrape,
    rows: check.rows,
    reason: 'drop',
    baseline,
    maxDrop,
  });
}

export interface YieldGuardInput {
  readonly scrape: string;
  readonly rows: number;
  readonly expect: YieldExpectation | undefined;
  readonly history: YieldHistory | undefined;
}

/**
 * Check, then record — and record ONLY a run that passed.
 *
 * That order is the mechanism, not an implementation detail. Recording a collapsed run would let
 * the baseline follow the collapse down: three broken runs at 2 rows and the median IS 2, so the
 * fourth broken run is within `maxDrop` of it and the alarm has silenced itself exactly when it
 * was working. A scraper that quietly re-baselines onto its own failure is the bug this file
 * exists to prevent, one level up.
 */
export async function guardYield(input: YieldGuardInput): Promise<void> {
  // No `expect` is no baseline either, deliberately: with no floor and no drop rule there is
  // nothing deciding whether a run was good, so recording it would let a stretch of silent
  // zero-row runs become the median an `expect` added later is measured against. The cost is that
  // `maxDrop` needs `MIN_BASELINE_RUNS` runs after it is declared before it can fire — a delay,
  // not a hole. `expect.test.ts` pins both halves.
  if (input.expect === undefined) return;
  const window = input.expect.window ?? DEFAULT_YIELD_WINDOW;
  const history =
    input.history === undefined ? [] : await input.history.recent(input.scrape, window);
  const problem = yieldProblem({
    scrape: input.scrape,
    rows: input.rows,
    expect: input.expect,
    history,
  });
  if (problem !== undefined) throw problem;
  await input.history?.record(input.scrape, input.rows);
}

/** In-memory history: what `fakeBrowser()` runs against, and what a test asserts on. */
export function memoryYieldHistory(
  seed: Readonly<Record<string, readonly number[]>> = {},
): YieldHistory {
  const runs = new Map<string, number[]>(
    Object.entries(seed).map(([name, values]) => [name, [...values]]),
  );
  return {
    recent: (scrape, limit) => Promise.resolve((runs.get(scrape) ?? []).slice(-limit)),
    record: (scrape, rows) => {
      const existing = runs.get(scrape) ?? [];
      existing.push(rows);
      runs.set(scrape, existing);
      return Promise.resolve();
    },
  };
}
