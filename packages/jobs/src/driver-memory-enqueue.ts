// The memory driver's enqueue half: insert, dedupe, `onConflict: 'error'` and `'replace'`, each
// row's `expiresAt`, and the backlog count `maxPending` reads — `SQL_ENQUEUE`, the claim's expiry
// arm and `SQL_BACKLOG` over a `Map`. Apart from `driver-memory.ts`, which is its claim loop.

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
  backlog(queue: string, cap: number): Promise<number>;
}

/** Through JSON, exactly as the pg driver binds it (`JSON.stringify(request.input ?? null)`). */
const stored = (input: unknown): unknown => JSON.parse(JSON.stringify(input ?? null)) as unknown;

export function memoryEnqueue({ jobs, clock, liveByKey }: MemoryEnqueueSeams): MemoryEnqueue {
  // A side table, as `expires_at` is a column no `JobRecord` reader needs: id → epoch ms.
  const expiries = new Map<string, number>();

  return {
    // `async` so `onConflict: 'error'` REJECTS here exactly as the pg driver's does.
    async enqueue(request) {
      // A caller-allocated id that already names a row is that row's publish, repeated: the same
      // job, whatever state it has reached — `SQL_ENQUEUE`'s `not exists` is the pg half.
      const published = request.id === undefined ? undefined : jobs.get(request.id);
      if (published !== undefined) {
        return { id: published.id, runId: published.runId, deduped: true };
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
        // Debounce: a holder still waiting takes the newer input and run time; a running or
        // suspended one is past replacing — `SQL_ENQUEUE`'s `do update ... where`.
        if (
          request.onConflict === 'replace' &&
          (existing.state === 'ready' || existing.state === 'delayed')
        ) {
          jobs.set(existing.id, {
            ...existing,
            input: stored(request.input),
            runAt,
            state: runAt > at ? 'delayed' : 'ready',
            updatedAt: at,
          });
        }
        return { id: existing.id, runId: existing.runId, deduped: true };
      }

      const record: JobRecord = {
        id: request.id ?? uuidV7(),
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
      if (request.expiresAt !== undefined) expiries.set(record.id, request.expiresAt);
      return { id: record.id, runId: record.runId, deduped: false };
    },

    expired(record, at) {
      const until = expiries.get(record.id);
      if (until === undefined || until > at) return false;
      if (record.state !== 'ready' && record.state !== 'delayed') return false;
      expiries.delete(record.id);
      return true;
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
