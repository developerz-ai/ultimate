// The per-process counter batch: settles add to a Map keyed (job, one-minute bucket), and one
// multi-row upsert writes it every `COUNTER_FLUSH_INTERVAL_MS` and on close. A per-settle upsert
// was the framework's largest WAL writer at idle-ish load. A crash loses at most one interval of
// COUNTS, a write whose commit is ambiguous (the connection died after it) counts twice, and a
// database down long enough drops the oldest buckets; the rows' `state` stays the truth.

import { logger, renderThrowable } from '@ultimat3/core';
import { counterBucketStart } from './counters';
import type { CounterOutcome } from './introspection';
import { COUNTER_BUCKET_MS } from './introspection';
import { type IntervalScheduler, realIntervalScheduler } from './renewal-timer';

/** How long a settle's count may wait in the process before it is written. */
export const COUNTER_FLUSH_INTERVAL_MS = 10_000;

/**
 * The most (job, minute) rows a process holds while its writes fail: a write that never lands kept
 * every bucket, so a database down for a day grew the batch by jobs x minutes, and the one
 * statement that finally wrote it with it. Past this the OLDEST buckets go, with one
 * `jobs.counters.dropped` warn naming how many counts — 10,000 is 100 job names for 100 minutes.
 */
export const COUNTER_PENDING_MAX_ROWS = 10_000;

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

  /** Past `COUNTER_PENDING_MAX_ROWS`, the oldest buckets go: history, never the ledger. */
  const bound = (): void => {
    if (pending.size <= COUNTER_PENDING_MAX_ROWS) return;
    const oldest = [...pending].sort(([, a], [, b]) => a.startMs - b.startMs);
    let counts = 0;
    const excess = oldest.slice(0, pending.size - COUNTER_PENDING_MAX_ROWS);
    for (const [key, row] of excess) {
      counts += row.done + row.retried + row.failed + row.dead;
      pending.delete(key);
    }
    logger.warn('jobs.counters.dropped', {
      rows: excess.length,
      counts,
      fix: 'x doctor --json — it names the database check that fails these writes',
    });
  };

  const write = async (): Promise<void> => {
    if (pending.size === 0) return;
    const rows = [...pending.values()].sort(byKey);
    pending = new Map();
    try {
      await options.write(rows);
    } catch (error) {
      // Kept, not dropped: the next flush adds them to whatever arrived meanwhile. Retried as
      // DELTAS, so a write that committed before its connection failed is counted twice — at
      // least once, never exactly once (`JobIntrospection.counters`).
      for (const row of rows) merge(row);
      bound();
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
