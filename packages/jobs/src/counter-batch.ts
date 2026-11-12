// The per-process counter batch: settles add to a Map keyed (job, one-minute bucket), and one
// multi-row upsert writes it every `COUNTER_FLUSH_INTERVAL_MS` and on close. A per-settle upsert
// was the framework's largest WAL writer at idle-ish load. A crash loses at most one interval of
// COUNTS; the rows' `state` stays the truth (`introspection.ts`, `counters`).

import { logger, renderThrowable } from '@ultimat3/core';
import { counterBucketStart } from './counters';
import type { CounterOutcome } from './introspection';
import { COUNTER_BUCKET_MS } from './introspection';
import { type IntervalScheduler, realIntervalScheduler } from './renewal-timer';

/** How long a settle's count may wait in the process before it is written. */
export const COUNTER_FLUSH_INTERVAL_MS = 10_000;

/** One `x_job_counters` delta: the one-minute bucket `startMs` opens, and what to add to it. */
export interface CounterFlushRow {
  readonly job: string;
  readonly startMs: number;
  readonly done: number;
  readonly retried: number;
  readonly failed: number;
  readonly dead: number;
  readonly durationMs: number;
}

export interface CounterBatchOptions {
  /** One statement for every row (`SQL_COUNTER_FLUSH`). Rejects: the rows stay pending. */
  readonly write: (rows: readonly CounterFlushRow[]) => Promise<void>;
  /** Default: a real, unrefed interval — never what keeps a drained process alive. */
  readonly schedule?: IntervalScheduler;
}

export interface CounterBatch {
  add(job: string, outcome: CounterOutcome, durationMs: number, atMs: number): void;
  /** Write what is pending; joins a flush already on the wire, then writes what arrived since. */
  flush(): Promise<void>;
  /** Disarm the timer and write what is pending. Logs a failed write; never rejects. */
  stop(): Promise<void>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const byKey = (a: CounterFlushRow, b: CounterFlushRow): number =>
  a.job < b.job ? -1 : a.job > b.job ? 1 : a.startMs - b.startMs;

export function counterBatch(options: CounterBatchOptions): CounterBatch {
  const schedule = options.schedule ?? realIntervalScheduler;
  let pending = new Map<string, Mutable<CounterFlushRow>>();
  let disarm: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;

  const merge = (row: CounterFlushRow): void => {
    const key = `${row.startMs}\u0000${row.job}`;
    const current = pending.get(key);
    if (current === undefined) {
      pending.set(key, { ...row });
      return;
    }
    current.done += row.done;
    current.retried += row.retried;
    current.failed += row.failed;
    current.dead += row.dead;
    current.durationMs += row.durationMs;
  };

  const write = async (): Promise<void> => {
    if (pending.size === 0) return;
    const rows = [...pending.values()].sort(byKey);
    pending = new Map();
    try {
      await options.write(rows);
    } catch (error) {
      // Kept, not dropped: the next flush adds them to whatever arrived meanwhile.
      for (const row of rows) merge(row);
      throw error;
    } finally {
      // An idle process holds no timer: the next settle arms one again.
      if (pending.size === 0) {
        disarm?.();
        disarm = undefined;
      }
    }
  };

  const flush = async (): Promise<void> => {
    while (inFlight !== undefined) await inFlight.catch(() => undefined);
    const current = write().finally(() => {
      inFlight = undefined;
    });
    inFlight = current;
    await current;
  };

  return {
    add(job, outcome, durationMs, atMs) {
      const startMs = counterBucketStart(atMs, COUNTER_BUCKET_MS);
      const row = { job, startMs, done: 0, retried: 0, failed: 0, dead: 0, durationMs };
      merge({ ...row, [outcome]: 1 });
      disarm ??= schedule(() => {
        flush().catch((error: unknown) => {
          logger.warn('jobs.counters.flush-failed', { error: renderThrowable(error) });
        });
      }, COUNTER_FLUSH_INTERVAL_MS);
    },
    flush,
    async stop() {
      disarm?.();
      disarm = undefined;
      await flush().catch((error: unknown) => {
        logger.warn('jobs.counters.flush-failed', {
          error: renderThrowable(error),
          lost: pending.size,
        });
      });
    },
  };
}
