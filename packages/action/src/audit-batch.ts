/**
 * Group commit for an audit sink: concurrent audited calls share one `writeMany`, so a pod doing
 * 200 audited writes a second pays a handful of round trips instead of 200. Each `write()` settles
 * with ITS record — a refused batch is retried singly — so the audit gate's two failure policies
 * see exactly what they saw before.
 */

import { finiteCount, MAX_TIMER_MS, onShutdown } from '@ultimat3/core';
import type { AuditRecord, AuditSink } from './audit';

/** Records per batch, by default: one statement's worth, well under any driver's message limit. */
export const DEFAULT_AUDIT_BATCH_MAX_RECORDS = 256;

/**
 * The longest a record waits for company, by default. It is latency every audited call pays when
 * traffic is light, so it is a few milliseconds — about one Postgres round trip — and not more.
 */
export const DEFAULT_AUDIT_BATCH_MAX_DELAY_MS = 5;

/** A sink that can write several records in one round trip — what group commit needs underneath. */
export interface BatchAuditSink extends AuditSink {
  writeMany(records: readonly AuditRecord[]): Promise<void>;
}

export interface BatchedAuditSinkOptions {
  /** A full batch is sent at once, without waiting out `maxDelayMs`. A whole number ≥ 1. */
  readonly maxRecords?: number | undefined;
  /** How long the first record of a batch waits for more. A whole number ≥ 0; 0 is one tick. */
  readonly maxDelayMs?: number | undefined;
}

export interface BatchedAuditSink extends BatchAuditSink {
  /** Resolves when this record is stored; rejects with the sink's error when it is not. */
  write(record: AuditRecord): Promise<void>;
  /** Send what is queued now and wait for every batch in flight. Never rejects: the waiters do. */
  flush(): Promise<void>;
  /** `flush()`, then unregister the drain hook. A sink built per test or per boot calls it. */
  close(): Promise<void>;
  /** Records queued and not yet sent — at most `maxRecords`. */
  readonly pending: number;
}

interface Waiter {
  readonly record: AuditRecord;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Every waiter gets ITS record's verdict. A failed `writeMany` is retried one record at a time,
 * because one record the store refuses (a byte `jsonb` cannot hold, a value over a column's
 * limit) fails the whole statement, and that must fail ONE call, not every call it carried. A
 * store that is down rejects each single too, so every waiter still gets an error, by IDENTITY
 * of what its own write threw: `auditSettled` wraps it into `X_AUDIT_SINK_FAILED` per call. Never
 * rejects itself — the waiters are where the failure belongs, and a rejection here would be an
 * unhandled one on the timer.
 */
async function commit(sink: BatchAuditSink, batch: readonly Waiter[]): Promise<void> {
  try {
    await sink.writeMany(batch.map((waiter) => waiter.record));
  } catch (error) {
    if (batch.length === 1) batch[0]?.reject(error);
    else await Promise.all(batch.map(single(sink)));
    return;
  }
  for (const waiter of batch) waiter.resolve();
}

const single =
  (sink: BatchAuditSink) =>
  async (waiter: Waiter): Promise<void> => {
    try {
      await sink.write(waiter.record);
    } catch (error) {
      waiter.reject(error);
      return;
    }
    waiter.resolve();
  };

/**
 * Wrap a `BatchAuditSink` so concurrent writes become one `writeMany`. The queue is bounded by
 * `maxRecords` — a full queue is sent, never grown — so a record pins its `Ctx` for at most
 * `maxDelayMs` plus one round trip.
 *
 * **Flushes on drain**: an `inflight`-phase shutdown hook, which runs after in-flight requests end
 * and before the `close` phase shuts the pool the sink writes through. `postgresAuditSink({
 * groupCommit: true })` is this over the Postgres sink; a custom sink with a `writeMany` wraps here.
 */
export function batchedAuditSink(
  sink: BatchAuditSink,
  options: BatchedAuditSinkOptions = {},
): BatchedAuditSink {
  const maxRecords = finiteCount(
    'batchedAuditSink',
    'maxRecords',
    options.maxRecords ?? DEFAULT_AUDIT_BATCH_MAX_RECORDS,
    1,
  );
  const maxDelayMs = Math.min(
    finiteCount(
      'batchedAuditSink',
      'maxDelayMs',
      options.maxDelayMs ?? DEFAULT_AUDIT_BATCH_MAX_DELAY_MS,
    ),
    MAX_TIMER_MS,
  );
  let queue: Waiter[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<Promise<void>>();

  const send = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const settled = commit(sink, batch);
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
  };

  const write = (record: AuditRecord): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      queue.push({ record, resolve, reject });
      if (queue.length >= maxRecords) send();
      // Ref'd on purpose: a queued record is an audit row owed, and the process stays up to pay it.
      else if (timer === undefined) timer = setTimeout(send, maxDelayMs);
    });

  const flush = async (): Promise<void> => {
    send();
    await Promise.all([...inFlight]);
  };

  const unregister = onShutdown('audit.batch', () => flush(), { phase: 'inflight' });

  return {
    write,
    async writeMany(records: readonly AuditRecord[]): Promise<void> {
      await Promise.all(records.map(write));
    },
    flush,
    async close(): Promise<void> {
      unregister();
      await flush();
    },
    get pending(): number {
      return queue.length;
    },
  };
}
