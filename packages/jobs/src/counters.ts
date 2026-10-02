// The per-job history counters: which bucket a settle lands in, what it adds, and how buckets
// age from one tier to the next. The arithmetic lives here ONCE — the memory store below runs it
// directly and the pg statements (`driver-pg-operator-sql.ts`) spell the same floor in SQL, so a
// count read under `x dev` and one read in production are the same number for the same settles.

import type { NackOptions } from './driver';
import { nackState } from './driver';
import type { CounterBucketMs, CounterOutcome, CounterTotals, JobCounter } from './introspection';
import { COUNTER_BUCKET_MS, COUNTER_TIERS } from './introspection';

/** The instant a bucket of `bucketMs` containing `atMs` opens. */
export const counterBucketStart = (atMs: number, bucketMs: number): number =>
  Math.floor(atMs / bucketMs) * bucketMs;

/**
 * What a nack adds, or nothing. A shed, a suspension and a drained attempt are handed back
 * UNCOUNTED and are not history: counting them would make every `step.sleep` a failure.
 */
export function nackOutcome(options: NackOptions): CounterOutcome | undefined {
  const state = nackState(options);
  if (state === 'dead') return 'dead';
  if (state === 'failed') return 'failed';
  return state === 'ready' && options.countsAsAttempt !== false ? 'retried' : undefined;
}

type Counts = Omit<JobCounter, 'job' | 'bucketStart' | 'bucketMs'>;

const ZERO: Counts = Object.freeze({ done: 0, retried: 0, failed: 0, dead: 0, durationMs: 0 });

const sum = (a: Counts, b: Counts): Counts => ({
  done: a.done + b.done,
  retried: a.retried + b.retried,
  failed: a.failed + b.failed,
  dead: a.dead + b.dead,
  durationMs: a.durationMs + b.durationMs,
});

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface MemoryCounters {
  add(job: string, outcome: CounterOutcome, durationMs: number, atMs: number): void;
  list(query: { readonly job: string; readonly sinceMs: number }): readonly JobCounter[];
  totals(sinceMs: number): readonly CounterTotals[];
  rollup(atMs: number): number;
}

/** The memory driver's counters. Same buckets, same tiers, same fold as `x_job_counters`. */
export function createMemoryCounters(): MemoryCounters {
  const buckets = new Map<string, JobCounter>();
  const keyOf = (job: string, bucketMs: number, bucketStart: number): string =>
    `${bucketMs}\u0000${bucketStart}\u0000${job}`;

  const merge = (
    job: string,
    bucketMs: CounterBucketMs,
    bucketStart: number,
    add: Counts,
  ): void => {
    const key = keyOf(job, bucketMs, bucketStart);
    const current = buckets.get(key);
    buckets.set(key, { job, bucketMs, bucketStart, ...sum(current ?? ZERO, add) });
  };

  return {
    add(job, outcome, durationMs, atMs) {
      const start = counterBucketStart(atMs, COUNTER_BUCKET_MS);
      merge(job, COUNTER_BUCKET_MS, start, { ...ZERO, [outcome]: 1, durationMs });
    },
    list({ job, sinceMs }) {
      return [...buckets.values()]
        .filter((bucket) => bucket.job === job && bucket.bucketStart >= sinceMs)
        .sort((a, b) => a.bucketStart - b.bucketStart || a.bucketMs - b.bucketMs);
    },
    totals(sinceMs) {
      const byJob = new Map<string, Counts>();
      for (const bucket of buckets.values()) {
        if (bucket.bucketStart < sinceMs) continue;
        byJob.set(bucket.job, sum(byJob.get(bucket.job) ?? ZERO, bucket));
      }
      return [...byJob.entries()]
        .sort(([a], [b]) => byName(a, b))
        .map(([job, counts]) => ({ job, ...sum(ZERO, counts) }));
    },
    rollup(atMs) {
      let moved = 0;
      for (const [index, tier] of COUNTER_TIERS.entries()) {
        const next = COUNTER_TIERS[index + 1];
        for (const [key, bucket] of [...buckets]) {
          if (bucket.bucketMs !== tier.bucketMs || bucket.bucketStart >= atMs - tier.keepMs)
            continue;
          buckets.delete(key);
          moved += 1;
          if (next === undefined) continue;
          merge(
            bucket.job,
            next.bucketMs,
            counterBucketStart(bucket.bucketStart, next.bucketMs),
            bucket,
          );
        }
      }
      return moved;
    },
  };
}
