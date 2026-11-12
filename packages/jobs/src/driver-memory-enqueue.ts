// The memory driver's enqueue half: insert, dedupe, `onConflict: 'error'` and `'replace'` (fenced
// by request order), each row's `expiresAt`, and the backlog count `maxPending` reads — the
// enqueue statements, the claim's expiry arm and `SQL_BACKLOG` over a `Map`.

import type { Clock } from '@ultimat3/core';
import { finiteCount, uuidV7 } from '@ultimat3/core';
import { nowMs } from './clock';
import type { EnqueueRequest, EnqueueResult, JobRecord } from './driver';
import { DEFAULT_QUEUE } from './driver';
import { JobDuplicateError } from './errors';

export interface MemoryEnqueueSeams {
  readonly jobs: Map<string, JobRecord>;
  readonly clock: Clock;
  readonly liveByKey: (name: string, key: string, tenantId?: string) => JobRecord | undefined;
}

export interface MemoryEnqueue {
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  /** True when the claim must settle `record` as expired rather than hand it out (and forgets it). */
  expired(record: JobRecord, at: number): boolean;
  /** Drop `id`'s expiry: the row ended, or `x jobs retry` made it new work. */
  forget(id: string): void;
  backlog(queue: string, cap: number): Promise<number>;
}

/** The idempotency namespace `x_jobs_name_tenant_idempotency_live_idx` keys: name, tenant, key. */
const sameKey = (row: JobRecord, request: EnqueueRequest): boolean =>
  row.name === request.name &&
  row.idempotencyKey === request.idempotencyKey &&
  (row.tenantId ?? '') === (request.tenantId ?? '');

/** Through JSON, exactly as the pg driver binds it (`JSON.stringify(request.input ?? null)`). */
const stored = (input: unknown): unknown => JSON.parse(JSON.stringify(input ?? null)) as unknown;

export function memoryEnqueue({ jobs, clock, liveByKey }: MemoryEnqueueSeams): MemoryEnqueue {
  // A side table, as `expires_at` is a column no `JobRecord` reader needs: id → epoch ms.
  const expiries = new Map<string, number>();
  // `debounced_id`, the same way: row id → the id of the request whose input it holds.
  const stamps = new Map<string, string>();

  /** `x_jobs_debounced_idx`'s read: a row of `request`'s key holding input no older than `id`. */
  const newer = (request: EnqueueRequest, id: string): JobRecord | undefined => {
    let found: JobRecord | undefined;
    let best = '';
    for (const [rowId, stamp] of stamps) {
      const row = jobs.get(rowId);
      // A row the operator removed takes its stamp with it, as a deleted pg row takes its column.
      if (row === undefined) {
        stamps.delete(rowId);
        continue;
      }
      if (stamp < id || stamp <= best || !sameKey(row, request)) continue;
      found = row;
      best = stamp;
    }
    return found;
  };

  /** Expiry is the latest request's: set by one, cleared by one that names none. */
  const expireAt = (id: string, expiresAt: number | undefined): void => {
    if (expiresAt === undefined) expiries.delete(id);
    else expiries.set(id, expiresAt);
  };

  return {
    // `async` so `onConflict: 'error'` REJECTS here exactly as the pg driver's does.
    async enqueue(request) {
      // A caller-allocated id that already names a row is that row's publish, repeated: the same
      // job, whatever state it has reached — `SQL_ENQUEUE`'s `not exists` is the pg half.
      const published = request.id === undefined ? undefined : jobs.get(request.id);
      if (published !== undefined) {
        return { id: published.id, runId: published.runId, deduped: true };
      }
      // Minted HERE, before any read, as the pg driver binds `$1`: the debounce fence's stamp.
      const id = request.id ?? uuidV7();
      const replace = request.onConflict === 'replace';
      // `SQL_ENQUEUE_REPLACE`'s `newer`: this request's input, or a newer one, already landed.
      const superseded = replace ? newer(request, id) : undefined;
      if (superseded !== undefined) {
        return { id: superseded.id, runId: superseded.runId, deduped: true };
      }
      const at = nowMs(clock);
      const runAt = request.runAt ?? at;
      const existing = liveByKey(request.name, request.idempotencyKey, request.tenantId);
      if (existing !== undefined) {
        if (request.onConflict === 'error') {
          throw new JobDuplicateError({
            job: request.name,
            idempotencyKey: request.idempotencyKey,
            existingId: existing.id,
          });
        }
        // Debounce: a holder still waiting takes the newer input, run time and expiry; a running
        // or suspended one is past replacing, and so is one holding a newer request's input —
        // `SQL_ENQUEUE_REPLACE`'s `do update ... where`.
        if (
          replace &&
          (existing.state === 'ready' || existing.state === 'delayed') &&
          (stamps.get(existing.id) ?? existing.id) < id
        ) {
          jobs.set(existing.id, {
            ...existing,
            input: stored(request.input),
            runAt,
            state: runAt > at ? 'delayed' : 'ready',
            updatedAt: at,
          });
          stamps.set(existing.id, id);
          expireAt(existing.id, request.expiresAt);
        }
        return { id: existing.id, runId: existing.runId, deduped: true };
      }

      const record: JobRecord = {
        id,
        name: request.name,
        queue: request.queue || DEFAULT_QUEUE,
        // A live reference kept a `Date`, an `undefined` member and a non-enumerable property the
        // queue in production never stores, so a job that read one passed here and failed there.
        input: stored(request.input),
        idempotencyKey: request.idempotencyKey,
        runId: request.runId ?? uuidV7(),
        attempt: 0,
        maxAttempts: request.maxAttempts,
        state: runAt > at ? 'delayed' : 'ready',
        runAt,
        createdAt: at,
        updatedAt: at,
        ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
        ...(request.traceparent === undefined ? {} : { traceparent: request.traceparent }),
        ...(request.enqueuedBy === undefined ? {} : { enqueuedBy: request.enqueuedBy }),
      };
      jobs.set(record.id, record);
      expireAt(record.id, request.expiresAt);
      if (replace) stamps.set(record.id, record.id);
      return { id: record.id, runId: record.runId, deduped: false };
    },

    expired(record, at) {
      const until = expiries.get(record.id);
      if (until === undefined || until > at) return false;
      // Never claimed only (`SQL_CLAIM`'s `attempt = 0`): a retry in its backoff already started.
      if (record.state !== 'ready' && record.state !== 'delayed') return false;
      if (record.attempt !== 0) return false;
      expiries.delete(record.id);
      return true;
    },

    forget(id) {
      expiries.delete(id);
    },

    backlog(queue, cap) {
      const limit = finiteCount('the memory driver backlog', 'cap', cap);
      let count = 0;
      for (const record of jobs.values()) {
        if (count >= limit) break;
        if (record.queue === queue && (record.state === 'ready' || record.state === 'delayed')) {
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
}
