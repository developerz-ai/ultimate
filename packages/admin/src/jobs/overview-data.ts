// What the jobs overview reads, and the arithmetic over it: queue depth from ONE `stats()`, the
// worker registry, and the settle counters folded into a fixed number of bars per range. Pure apart
// from `overviewData`, so the chart's bucketing is tested without a queue.

import { expectedQueryLoop } from '@ultimat3/db';
import {
  type CounterTotals,
  inspectQueues,
  type JobCounter,
  type JobIntrospection,
} from '@ultimat3/jobs';
import { AdminFilterInvalidError } from '../errors';
import { jobsOperator } from './operator';

/** The ranges the chart and the per-name table answer, and how many bars each is drawn in. */
export const OVERVIEW_RANGES = {
  '1h': { ms: 3_600_000, bars: 12 },
  '24h': { ms: 86_400_000, bars: 24 },
  '7d': { ms: 604_800_000, bars: 28 },
  '30d': { ms: 2_592_000_000, bars: 30 },
} as const;

export type OverviewRange = keyof typeof OVERVIEW_RANGES;
export const RANGE_PARAM = 'range';
export const DEFAULT_RANGE: OverviewRange = '24h';
const RANGES: ReadonlyMap<string, OverviewRange> = new Map(
  (Object.keys(OVERVIEW_RANGES) as OverviewRange[]).map((key) => [key, key]),
);

/** `?range=` as one of the four; absent is the default, anything else is refused by name. */
export function rangeOf(url: URL): OverviewRange {
  const asked = url.searchParams.get(RANGE_PARAM);
  if (asked === null || asked === '') return DEFAULT_RANGE;
  const range = RANGES.get(asked);
  if (range !== undefined) return range;
  throw new AdminFilterInvalidError({
    entity: 'jobs',
    asked: `${RANGE_PARAM}=${asked}`,
    cause: 'is not a range the overview draws',
    known: [...RANGES.keys()].map((key) => `${RANGE_PARAM}=${key}`),
  });
}

export interface OverviewBar {
  readonly startMs: number;
  readonly done: number;
  /** Runs that ended badly: `failed` and `dead`. A retried attempt is not an ending. */
  readonly failed: number;
}

/** Every bucket from `sinceMs` on, whatever tier it lives in, summed into `bars` equal bars. */
export function barsOf(
  counters: readonly JobCounter[],
  range: OverviewRange,
  nowMs: number,
): readonly OverviewBar[] {
  const { ms, bars } = OVERVIEW_RANGES[range];
  const width = ms / bars;
  const start = nowMs - ms;
  const out = Array.from({ length: bars }, (_, index) => ({
    startMs: start + index * width,
    done: 0,
    failed: 0,
  }));
  for (const bucket of counters) {
    const index = Math.floor((bucket.bucketStart - start) / width);
    const bar = out[Math.min(bars - 1, Math.max(0, index))];
    if (bar === undefined) continue;
    bar.done += bucket.done;
    bar.failed += bucket.failed + bucket.dead;
  }
  return out;
}

export interface NameRow {
  readonly name: string;
  /** Runs that ended in the range: done, failed and dead. */
  readonly volume: number;
  /** Of those, the share that did not end done — `null` when none ended. */
  readonly failureRate: number | null;
  /** Mean attempt duration, retries included — `null` when nothing was attempted. */
  readonly meanMs: number | null;
}

export function nameRowsOf(totals: readonly CounterTotals[]): readonly NameRow[] {
  return totals.map((row) => {
    const volume = row.done + row.failed + row.dead;
    const attempts = volume + row.retried;
    return {
      name: row.job,
      volume,
      failureRate: volume === 0 ? null : (row.failed + row.dead) / volume,
      meanMs: attempts === 0 ? null : row.durationMs / attempts,
    };
  });
}

/** The fallback for a driver that ships no `countersMany`: one read per name, declared. */
function countersPerName(
  introspect: JobIntrospection,
  jobs: readonly string[],
  sinceMs: number,
): Promise<readonly JobCounter[]> {
  return expectedQueryLoop(
    'the jobs overview reads each settled job name’s counter buckets: this driver has no countersMany',
    async () => {
      const all: JobCounter[] = [];
      for (const job of jobs) all.push(...(await introspect.counters({ job, sinceMs })));
      return all;
    },
  );
}

export interface OverviewData {
  readonly totals: Awaited<ReturnType<typeof inspectQueues>>['totals'];
  readonly oldestReadyMs: number;
  readonly workers: number;
  readonly bars: readonly OverviewBar[];
  readonly names: readonly NameRow[];
}

/**
 * Four statements whatever the app's size: queue depth, the worker registry, the totals (which
 * names have buckets at all), then every one of those names' buckets in ONE `countersMany` read.
 * A driver without it is read one `counters` call per name — declared, bounded by the app's
 * registered job names.
 */
export async function overviewData(range: OverviewRange, nowMs: number): Promise<OverviewData> {
  const { driver, introspect } = jobsOperator();
  const sinceMs = nowMs - OVERVIEW_RANGES[range].ms;
  const [depth, workers, totals] = await Promise.all([
    inspectQueues(driver),
    introspect.workers(),
    introspect.counterTotals(sinceMs),
  ]);
  const jobs = totals.map((row) => row.job);
  const counters =
    introspect.countersMany === undefined
      ? await countersPerName(introspect, jobs, sinceMs)
      : await introspect.countersMany({ jobs, sinceMs });
  return {
    totals: depth.totals,
    oldestReadyMs: depth.oldestReadyMs,
    workers: workers.length,
    bars: barsOf(counters, range, nowMs),
    names: nameRowsOf(totals),
  };
}
