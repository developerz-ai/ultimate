// `handle.enqueueMany(inputs)`: many jobs of one kind in one statement per chunk, on the same two
// paths `enqueue` takes — staged in the caller's transaction, or straight to the driver. A loop of
// `enqueue` is the N+1 write the detector refuses (`X_N_PLUS_ONE_WRITE`): 1,000 rows were 1,000
// statements and a second on Postgres, against one statement and 18 ms (measured 2026-11-02).

import { uuidV7 } from '@ultimat3/core';
import { refuseAbandoned } from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { nowMs } from './clock';
import type { EnqueueResult } from './driver';
import { ambientTraceparent, directRequest, stagedRecord } from './enqueue-record';
import { signalEnqueued, signalStaged } from './enqueue-signal';
import { JobEnqueueBatchTooLargeError, OutboxNoTxError } from './errors';
import type { JobHandle } from './job';
import type { EnqueueOptions, OutboxDeps, OutboxRecord, OutboxStore } from './outbox';
import { refuseEnqueueTenant } from './tenant';

/**
 * The most inputs one call takes. A list longer than this is a table, and a table is paged by a
 * `backfill()` — never held whole in memory and staged inside one request's transaction.
 */
export const MAX_ENQUEUE_BATCH = 10_000;

/** Rows per statement: bounds one bind's size, and so the time one statement holds its locks. */
export const ENQUEUE_CHUNK = 1_000;

/**
 * One set of options for the whole batch, and no `runId`: one id names one run. No `onConflict`
 * or `expiresAt` either — a single enqueue's (`assertEnqueueMany`). A batch whose inputs need
 * options of their own is a loop of `enqueue`.
 */
export type EnqueueManyOptions = Omit<EnqueueOptions, 'runId' | 'onConflict' | 'expiresAt'>;

function chunked<T>(rows: readonly T[]): readonly (readonly T[])[] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += ENQUEUE_CHUNK) {
    out.push(rows.slice(at, at + ENQUEUE_CHUNK));
  }
  return out;
}

/** Stage `records` in `tx` in one statement when the store can, else one by one, in order. */
export async function stageAll(
  store: OutboxStore,
  tx: Tx,
  records: readonly OutboxRecord[],
): Promise<void> {
  if (store.stageMany !== undefined) return store.stageMany(tx, records);
  for (const record of records) await store.stage(tx, record);
}

/**
 * The facade's `enqueueMany`. Every refusal is decided before the first write: the abandoned
 * scope, the size, and each input's idempotency and concurrency keys — an empty key in input 900
 * refuses the call, not the rows after 899. Answers in input order; two inputs sharing a key are
 * one job, the second answered `deduped: true` on the direct path.
 *
 * ATOMIC PER CHUNK on the direct path: a failure past a chunk boundary leaves the earlier chunks
 * enqueued. Inside `withTransaction` the batch is staged, and commits or vanishes whole.
 */
export async function enqueueMany<I>(
  deps: OutboxDeps,
  tx: Tx | undefined,
  handle: JobHandle<I>,
  inputs: readonly I[],
  options: EnqueueManyOptions = {},
): Promise<readonly EnqueueResult[]> {
  refuseAbandoned();
  if (inputs.length > MAX_ENQUEUE_BATCH) {
    throw new JobEnqueueBatchTooLargeError({
      job: handle.name,
      count: inputs.length,
      max: MAX_ENQUEUE_BATCH,
    });
  }
  if (inputs.length === 0) return [];
  const at = nowMs(deps.clock);
  const trace = options.traceparent ?? ambientTraceparent();
  // Allocated here on both paths, so the answer needs no read per row.
  const rows = inputs.map((input) => {
    handle.concurrencyKeyFor(input);
    refuseEnqueueTenant(handle.name, handle.tenantFor(input), options.tenantId);
    const idempotencyKey = handle.idempotencyKeyFor(input);
    return { input, facts: { id: uuidV7(), runId: uuidV7(), idempotencyKey, at, trace } };
  });

  if (tx === undefined) {
    if (deps.mode === 'required' && options.outbox !== false) {
      throw new OutboxNoTxError({ job: handle.name });
    }
    const requests = rows.map((row) => directRequest(handle, row.input, options, row.facts));
    const results: EnqueueResult[] = [];
    for (const chunk of chunked(requests)) {
      // Before EVERY chunk: a direct write is one no transaction guard sees, and a scope abandoned
      // while chunk 3 was in flight must not start chunks 4 to 10.
      refuseAbandoned();
      results.push(...(await deps.driver.enqueueMany(chunk)));
    }
    signalEnqueued(options.queue ?? handle.queue);
    return results;
  }

  const records = rows.map((row) => stagedRecord(handle, row.input, options, row.facts));
  for (const chunk of chunked(records)) await stageAll(deps.store, tx, chunk);
  signalStaged();
  // As `enqueue` answers a staged row: the ids are the jobs' to be, and only the publish knows
  // whether a LIVE job already held the key.
  return records.map((record) => ({ id: record.id, runId: record.runId, deduped: false }));
}
