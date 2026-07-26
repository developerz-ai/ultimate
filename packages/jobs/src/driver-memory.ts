// In-process driver for `x dev` and tests: same semantics as pg (visibility timeout,
// idempotency dedupe, dead-letter) with zero infrastructure, so a test suite exercises the
// real claim/ack/nack paths rather than a mock that always succeeds.

import type { Clock } from '@ultimat3/core';
import { assert, systemClock, uuid } from '@ultimat3/core';
import { nowMs } from './clock';
import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  JobFilter,
  JobIntrospection,
  JobRecord,
  NackOptions,
  QueueStats,
} from './driver';
import { DEFAULT_QUEUE } from './driver';
import { JobDuplicateError } from './errors';
import type { StepStore } from './steps';
import { createMemoryStepStore } from './steps';

export interface MemoryDriverOptions {
  readonly clock?: Clock;
  readonly steps?: StepStore;
}

const LIVE_STATES = new Set(['ready', 'delayed', 'running', 'suspended']);

export function createMemoryDriver(options: MemoryDriverOptions = {}): JobDriver {
  const clock = options.clock ?? systemClock;
  const steps = options.steps ?? createMemoryStepStore();
  const jobs = new Map<string, JobRecord>();

  const liveByKey = (key: string): JobRecord | undefined => {
    for (const record of jobs.values()) {
      if (record.idempotencyKey === key && LIVE_STATES.has(record.state)) return record;
    }
    return undefined;
  };

  const update = (id: string, patch: Partial<JobRecord>): void => {
    const existing = jobs.get(id);
    if (existing === undefined) return;
    jobs.set(id, { ...existing, ...patch, updatedAt: nowMs(clock) });
  };

  const introspect: JobIntrospection = {
    job(jobId) {
      return Promise.resolve(jobs.get(jobId));
    },
    list(filter: JobFilter = {}) {
      const rows = [...jobs.values()]
        .filter((record) => filter.queue === undefined || record.queue === filter.queue)
        .filter((record) => filter.name === undefined || record.name === filter.name)
        .filter((record) => filter.state === undefined || record.state === filter.state)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, filter.limit ?? 100);
      return Promise.resolve(rows);
    },
    deadLetters(limit = 100) {
      const rows = [...jobs.values()]
        .filter((record) => record.state === 'dead')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
      return Promise.resolve(rows);
    },
    async requeue(jobId, requeueOptions) {
      const existing = jobs.get(jobId);
      assert(
        existing !== undefined,
        `no job ${jobId} in the memory driver`,
        'requeue a job id returned by enqueue() or stats() — the memory driver holds no state across processes, so an id from another run will not resolve',
      );
      const record = existing;
      if (requeueOptions?.fromStep !== undefined) {
        // Drop the target step so it re-executes; earlier steps stay memoized.
        await steps.del(record.runId, requeueOptions.fromStep);
      }
      update(jobId, { state: 'ready', attempt: 0, runAt: nowMs(clock) });
      const next = jobs.get(jobId);
      return next ?? record;
    },
  };

  return {
    name: 'memory',
    steps,
    introspect,

    enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const existing = liveByKey(request.idempotencyKey);
      if (existing !== undefined) {
        if (request.onConflict === 'error') {
          throw new JobDuplicateError({
            job: request.name,
            idempotencyKey: request.idempotencyKey,
            existingId: existing.id,
          });
        }
        return Promise.resolve({ id: existing.id, runId: existing.runId, deduped: true });
      }

      const at = nowMs(clock);
      const runAt = request.runAt ?? at;
      const record: JobRecord = {
        id: uuid(),
        name: request.name,
        queue: request.queue || DEFAULT_QUEUE,
        input: request.input,
        idempotencyKey: request.idempotencyKey,
        runId: request.runId ?? uuid(),
        attempt: 0,
        maxAttempts: request.maxAttempts,
        state: runAt > at ? 'delayed' : 'ready',
        runAt,
        createdAt: at,
        updatedAt: at,
        ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
      };
      jobs.set(record.id, record);
      return Promise.resolve({ id: record.id, runId: record.runId, deduped: false });
    },

    claim(claimOptions: ClaimOptions): Promise<readonly ClaimedJob[]> {
      const at = nowMs(clock);
      const wanted = new Set(claimOptions.queues);
      const claimable = [...jobs.values()]
        .filter((record) => wanted.size === 0 || wanted.has(record.queue))
        .filter((record) => {
          if (record.runAt > at) return false;
          if (record.state === 'ready' || record.state === 'delayed') return true;
          if (record.state === 'suspended') return true;
          // Lease expiry: a worker that died without ack releases its job here.
          return record.state === 'running' && (record.visibleAt ?? 0) <= at;
        })
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, claimOptions.limit);

      const out: ClaimedJob[] = [];
      for (const record of claimable) {
        const claimed: ClaimedJob = {
          ...record,
          state: 'running',
          attempt: record.attempt + 1,
          claimedBy: claimOptions.workerId,
          claimedAt: at,
          visibleAt: at + claimOptions.visibilityTimeoutMs,
          updatedAt: at,
        };
        jobs.set(record.id, claimed);
        out.push(claimed);
      }
      return Promise.resolve(out);
    },

    ack(jobId: string): Promise<void> {
      update(jobId, { state: 'done' });
      return Promise.resolve();
    },

    nack(jobId: string, nackOptions: NackOptions): Promise<void> {
      const record = jobs.get(jobId);
      if (record === undefined) return Promise.resolve();
      const at = nowMs(clock);
      const counts = nackOptions.countsAsAttempt !== false;
      const patch: Partial<JobRecord> = {
        state: nackOptions.deadLetter === true ? 'dead' : counts ? 'ready' : 'suspended',
        runAt: at + nackOptions.delayMs,
        // A suspension must not burn an attempt, or a 3-day sleep dead-letters the run.
        attempt: counts ? record.attempt : record.attempt - 1,
        ...(nackOptions.error === undefined ? {} : { lastError: nackOptions.error }),
      };
      update(jobId, patch);
      return Promise.resolve();
    },

    heartbeat(jobId: string, heartbeatOptions): Promise<void> {
      update(jobId, { visibleAt: nowMs(clock) + heartbeatOptions.visibilityTimeoutMs });
      return Promise.resolve();
    },

    stats(): Promise<readonly QueueStats[]> {
      const at = nowMs(clock);
      const byQueue = new Map<string, QueueStats>();
      for (const record of jobs.values()) {
        const current = byQueue.get(record.queue) ?? {
          queue: record.queue,
          ready: 0,
          delayed: 0,
          running: 0,
          suspended: 0,
          dead: 0,
          oldestReadyMs: 0,
        };
        const next = { ...current };
        if (record.state === 'ready' && record.runAt <= at) {
          next.ready += 1;
          next.oldestReadyMs = Math.max(next.oldestReadyMs, at - record.runAt);
        } else if (record.state === 'ready' || record.state === 'delayed') next.delayed += 1;
        else if (record.state === 'running') next.running += 1;
        else if (record.state === 'suspended') next.suspended += 1;
        else if (record.state === 'dead') next.dead += 1;
        byQueue.set(record.queue, next);
      }
      return Promise.resolve([...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue)));
    },

    close(): Promise<void> {
      jobs.clear();
      return Promise.resolve();
    },
  };
}
