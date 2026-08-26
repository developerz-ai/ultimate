// In-process driver for `x dev` and tests: same semantics as pg (visibility timeout,
// idempotency dedupe, dead-letter) with zero infrastructure, so a test suite exercises the
// real claim/ack/nack paths rather than a mock that always succeeds.

import type { Clock } from '@ultimat3/core';
import { assert, finiteCount, systemClock, uuid } from '@ultimat3/core';
import type { BackfillLedger } from './backfill-ledger';
import { createMemoryBackfillLedger } from './backfill-ledger';
import { nowMs } from './clock';
import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  JobFilter,
  JobIntrospection,
  JobRecord,
  NackOptions,
  QueueStats,
} from './driver';
import { assertClaimBounds, assertClaimQueues, DEFAULT_QUEUE } from './driver';
import { JobDuplicateError } from './errors';
import type { LeaseStore } from './leases';
import { createMemoryLeaseStore } from './leases';
import type { StepStore } from './steps';
import { createMemoryStepStore } from './steps';

export interface MemoryDriverOptions {
  readonly clock?: Clock;
  readonly steps?: StepStore;
  /** Injectable for the same reason `steps` is: two drivers in one test sharing one ledger. */
  readonly backfills?: BackfillLedger;
  /** Injectable so two drivers in one test can share one set of fleet slots. */
  readonly leases?: LeaseStore;
}

const LIVE_STATES = new Set(['ready', 'delayed', 'running', 'suspended']);

/**
 * The in-memory driver's own type: `JobDriver` with `close` REQUIRED.
 *
 * `JobDriver.close` is optional because a driver may hold nothing to release. This one always
 * does — it clears the job map — and every wrapper in the test suite delegates through
 * `base.close()`. Declaring it here is what makes that delegation a CHECKED call: against a plain
 * `JobDriver` the only way to write it is `base.close?.()`, which a driver that quietly stopped
 * shipping a `close` would satisfy in silence.
 */
export type MemoryJobDriver = JobDriver & { close(): Promise<void> };

export function createMemoryDriver(options: MemoryDriverOptions = {}): MemoryJobDriver {
  const clock = options.clock ?? systemClock;
  const steps = options.steps ?? createMemoryStepStore();
  const backfills = options.backfills ?? createMemoryBackfillLedger(clock);
  const leases =
    options.leases ?? createMemoryLeaseStore(options.clock === undefined ? {} : { clock });
  const jobs = new Map<string, JobRecord>();

  // Keyed by NAME, TENANT and key, exactly as `x_jobs_name_tenant_idempotency_live_idx` is. A
  // global key namespace let two unrelated jobs that derived the same natural key dedupe against
  // each other: the second enqueue returned the first's id and its work never ran. A tenant-blind
  // one did the same ACROSS tenants, where the id handed back belongs to somebody else and is
  // valid on every id-addressed surface. `?? ''` mirrors the index's `coalesce`, so all tenantless
  // rows share one namespace rather than each becoming its own.
  const liveByKey = (name: string, key: string, tenantId?: string): JobRecord | undefined => {
    for (const record of jobs.values()) {
      if (
        record.name === name &&
        record.idempotencyKey === key &&
        (record.tenantId ?? '') === (tenantId ?? '') &&
        LIVE_STATES.has(record.state)
      ) {
        return record;
      }
    }
    return undefined;
  };

  const update = (id: string, patch: Partial<JobRecord>): void => {
    const existing = jobs.get(id);
    if (existing === undefined) return;
    jobs.set(id, { ...existing, ...patch, updatedAt: nowMs(clock) });
  };

  /**
   * `update`, plus the lease columns `SQL_ACK`/`SQL_NACK` set to `null`.
   *
   * A settlement RELEASES the claim, and a `Partial<JobRecord>` cannot say so: both fields are
   * optional, so `visibleAt: undefined` would keep the key and `{ ...existing }` keeps the value.
   * Left stamped, a `done` row still named the worker that finished it and carried that attempt's
   * lease deadline — which `x jobs show` prints, and which is the very pair the claim scan's
   * lease-expiry branch reads to decide a row was abandoned.
   */
  const settle = (id: string, patch: Partial<JobRecord>): void => {
    const existing = jobs.get(id);
    if (existing === undefined) return;
    const { visibleAt: _visibleAt, claimedBy: _claimedBy, ...released } = existing;
    jobs.set(id, { ...released, ...patch, updatedAt: nowMs(clock) });
  };

  const introspect: JobIntrospection = {
    job(jobId) {
      return Promise.resolve(jobs.get(jobId));
    },
    // `async` for the reason `claim` is: a refused bound must REJECT here exactly as it does on the
    // pg driver, and a synchronous throw out of a method typed `Promise<…>` is a second answer to
    // one question.
    async list(filter: JobFilter = {}) {
      const rows = [...jobs.values()]
        .filter((record) => filter.queue === undefined || record.queue === filter.queue)
        .filter((record) => filter.name === undefined || record.name === filter.name)
        .filter((record) => filter.state === undefined || record.state === filter.state)
        // NEWEST first, as `createPgDriver`'s `order by created_at desc` is. Ascending here meant
        // `x jobs ls` answered one thing against `x dev` and the opposite in production — and,
        // because the limit is applied after the sort, a default page of the hundred OLDEST rows.
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, finiteCount('the memory driver list', 'limit', filter.limit ?? 100));
      return rows;
    },
    async deadLetters(limit = 100) {
      const rows = [...jobs.values()]
        .filter((record) => record.state === 'dead')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, finiteCount('the memory driver dead letters', 'limit', limit));
      return rows;
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
    cancel(jobId, reason) {
      const existing = jobs.get(jobId);
      // `state !== 'done'`, mirroring `SQL_CANCEL`: a job that already finished has nothing to
      // stop, and cancelling it would rewrite a terminal row an operator is reading as success.
      if (existing === undefined || existing.state === 'done') return Promise.resolve(undefined);
      update(jobId, {
        state: 'cancelled',
        ...(reason === undefined ? {} : { lastError: reason }),
      });
      return Promise.resolve(jobs.get(jobId));
    },
  };

  return {
    name: 'memory',
    steps,
    backfills,
    leases,
    introspect,

    enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const existing = liveByKey(request.name, request.idempotencyKey, request.tenantId);
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
        ...(request.traceparent === undefined ? {} : { traceparent: request.traceparent }),
        ...(request.enqueuedBy === undefined ? {} : { enqueuedBy: request.enqueuedBy }),
      };
      jobs.set(record.id, record);
      return Promise.resolve({ id: record.id, runId: record.runId, deduped: false });
    },

    // `async`, so an empty queue list REJECTS here exactly as it does on the pg driver: a
    // synchronous throw out of a method typed `Promise<…>` is a different answer to the same
    // question, which is the class of divergence this pair is checked for.
    async claim(claimOptions: ClaimOptions): Promise<readonly ClaimedJob[]> {
      assertClaimQueues('memory', claimOptions);
      assertClaimBounds('memory', claimOptions);
      const at = nowMs(clock);
      const wanted = new Set(claimOptions.queues);
      const claimable = [...jobs.values()]
        .filter((record) => wanted.has(record.queue))
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

    // Both settlements are FENCED on `running`, as `SQL_ACK`/`SQL_NACK` are: an ack from a worker
    // whose job was cancelled — or whose lease lapsed and whose job another worker re-claimed —
    // would otherwise overwrite a row it no longer owns.
    ack(jobId: string): Promise<void> {
      if (jobs.get(jobId)?.state !== 'running') return Promise.resolve();
      settle(jobId, { state: 'done' });
      return Promise.resolve();
    },

    nack(jobId: string, nackOptions: NackOptions): Promise<void> {
      const record = jobs.get(jobId);
      if (record === undefined || record.state !== 'running') return Promise.resolve();
      const at = nowMs(clock);
      const counts = nackOptions.countsAsAttempt !== false;
      const patch: Partial<JobRecord> = {
        // `park`, never `counts`: parking is what leaves the ready bucket, and burning an attempt
        // is a separate fact. A shed sets neither and stays `ready`, which is what it is.
        state:
          nackOptions.deadLetter === true
            ? 'dead'
            : nackOptions.park === true
              ? 'suspended'
              : 'ready',
        runAt: at + nackOptions.delayMs,
        // A suspension must not burn an attempt, or a 3-day sleep dead-letters the run. Floored
        // where `SQL_NACK` floors it (`greatest(attempt - 1, 0)`): the fence above is what keeps
        // the decrement paired with a claim today, so this is the guard that survives the fence
        // being read as the only one.
        attempt: counts ? record.attempt : Math.max(0, record.attempt - 1),
        ...(nackOptions.error === undefined ? {} : { lastError: nackOptions.error }),
      };
      settle(jobId, patch);
      return Promise.resolve();
    },

    heartbeat(jobId: string, heartbeatOptions: HeartbeatOptions): Promise<boolean> {
      const record = jobs.get(jobId);
      // The same predicate `SQL_HEARTBEAT` carries. `false` is how an external cancel reaches a
      // job that is already running: the worker's next renewal misses and the attempt is aborted.
      if (
        record === undefined ||
        record.state !== 'running' ||
        (heartbeatOptions.workerId !== undefined && record.claimedBy !== heartbeatOptions.workerId)
      ) {
        return Promise.resolve(false);
      }
      update(jobId, { visibleAt: nowMs(clock) + heartbeatOptions.visibilityTimeoutMs });
      return Promise.resolve(true);
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
