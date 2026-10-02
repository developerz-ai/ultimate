// In-process driver for `x dev` and tests: same semantics as pg (visibility timeout,
// idempotency dedupe, dead-letter) with zero infrastructure, so a test suite exercises the
// real claim/ack/nack paths rather than a mock that always succeeds.

import type { Clock } from '@ultimat3/core';
import { finiteCount, systemClock, uuid } from '@ultimat3/core';
import type { BackfillLedger } from './backfill-ledger';
import { createMemoryBackfillLedger } from './backfill-ledger';
import { nowMs } from './clock';
import { nackOutcome } from './counters';
import type {
  AckOptions,
  ClaimedJob,
  ClaimIdentity,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  JobRecord,
  NackOptions,
  QueueStats,
} from './driver';
import {
  assertClaimBounds,
  assertClaimQueues,
  DEFAULT_QUEUE,
  LEASE_LAPSED_FINAL_ATTEMPT,
  LIVE_STATES,
  nackState,
  REQUEUEABLE_STATES,
} from './driver';
import { createMemoryOperator } from './driver-memory-operator';
import { signalEnqueued } from './enqueue-signal';
import { JobDuplicateError, LeaseLostError } from './errors';
import { JobNotFoundError, JobNotRequeueableError, requeueKeyTaken } from './errors-requeue';
import type { JobIntrospection } from './introspection';
import { MAX_ERROR_STACK_LENGTH } from './introspection';
import type { LeaseStore } from './leases';
import { createMemoryLeaseStore } from './leases';
import { isFinalAttempt } from './retry';
import type { StepStore } from './steps';
import { createMemoryStepStore } from './steps-memory';

export interface MemoryDriverOptions {
  readonly clock?: Clock;
  readonly steps?: StepStore;
  /** Injectable for the same reason `steps` is: two drivers in one test sharing one ledger. */
  readonly backfills?: BackfillLedger;
  /** Injectable so two drivers in one test can share one set of fleet slots. */
  readonly leases?: LeaseStore;
}

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
  const stepStore = options.steps ?? createMemoryStepStore();
  // `SQL_STEP_PUT`'s fence: a write made under a claim lands only while that claim holds the row.
  const steps: StepStore = {
    ...stepStore,
    put(record, by) {
      const row = by === undefined ? undefined : jobs.get(by.jobId);
      if (
        by !== undefined &&
        !(row?.state === 'running' && row.claimedBy === by.workerId && row.claim === by.claim)
      ) {
        return Promise.reject(new LeaseLostError({ job: by.job, jobId: by.jobId }));
      }
      return stepStore.put(record);
    },
  };
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
  const settle = (id: string, patch: Partial<JobRecord>, drop?: 'stack'): void => {
    const existing = jobs.get(id);
    if (existing === undefined) return;
    const { visibleAt: _visibleAt, claimedBy: _claimedBy, ...released } = existing;
    // `drop: 'stack'` is `SQL_NACK`'s `case when $5 is null then last_error_stack else $7 end`
    // with no stack bound: a NEW failure replaces the old one's stack even with nothing — the key
    // is removed, never set to `undefined`, as a null column is absent from a pg record.
    const { lastErrorStack: _stack, ...unstacked } = released;
    jobs.set(id, {
      ...(drop === 'stack' ? unstacked : released),
      ...patch,
      updatedAt: nowMs(clock),
    });
  };

  const operator = createMemoryOperator({
    jobs,
    steps,
    clock,
    settle,
    liveHolder: (record) => {
      const holder = liveByKey(record.name, record.idempotencyKey, record.tenantId);
      return holder === undefined || holder.id === record.id ? undefined : holder;
    },
  });

  /** The row, when this worker still holds it `running` — the fence both settles share. */
  const heldBy = (jobId: string, by: ClaimIdentity): JobRecord | undefined => {
    const record = jobs.get(jobId);
    return record?.state === 'running' &&
      record.claimedBy === by.workerId &&
      record.claim === by.claim
      ? record
      : undefined;
  };

  const introspect: JobIntrospection = {
    job(jobId) {
      return Promise.resolve(jobs.get(jobId));
    },
    ...operator.members,
    async deadLetters(limit = 100) {
      const rows = [...jobs.values()]
        .filter((record) => record.state === 'dead')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, finiteCount('the memory driver dead letters', 'limit', limit));
      return rows;
    },
    async requeue(jobId, requeueOptions) {
      const record = jobs.get(jobId);
      // The one answer both drivers give an id nobody queued — it was `X_INVARIANT` here.
      if (record === undefined) throw new JobNotFoundError({ jobId, driver: 'memory' });
      // The two refusals `SQL_JOB_REQUEUE` and `SQL_JOB_LIVE_HOLDER` give, before anything moves.
      if (!REQUEUEABLE_STATES.has(record.state)) {
        throw new JobNotRequeueableError({ jobId, state: record.state });
      }
      const holder = liveByKey(record.name, record.idempotencyKey, record.tenantId);
      if (holder !== undefined && holder.id !== jobId) {
        throw requeueKeyTaken({ ...record, holderId: holder.id });
      }
      if (requeueOptions?.fromStep !== undefined) {
        // The target step and every step that started AFTER it — `SQL_JOB_REQUEUE`, whose header
        // says why a tie is kept. Earlier steps stay memoized; a later one replaying the old run's
        // result is what this prevents.
        const all = await steps.list(record.runId);
        const target = all.find((step) => step.name === requeueOptions.fromStep);
        if (target !== undefined) {
          for (const step of all) {
            if (step === target || step.startedAt > target.startedAt) {
              await steps.del(record.runId, step.name);
            }
          }
        }
      }
      // `settle` releases the claim — `SQL_JOB_REQUEUE` writes `claimed_by = null` too.
      settle(jobId, { state: 'ready', attempt: 0, runAt: nowMs(clock) });
      signalEnqueued(record.queue);
      const next = jobs.get(jobId);
      return next ?? record;
    },
    cancel(jobId, reason) {
      const existing = jobs.get(jobId);
      // LIVE rows only, mirroring `SQL_CANCEL`: a job that already finished has nothing to stop.
      // The fence was `state !== 'done'`, which let a cancel REWRITE a dead letter — the record of
      // a failure, and its `lastError`, became the record of an operator's typo.
      if (existing === undefined || !LIVE_STATES.has(existing.state)) {
        return Promise.resolve(undefined);
      }
      // `settle`, not `update`: a cancellation RELEASES the claim, and `SQL_CANCEL` writes
      // `visible_at = null, claimed_by = null` with the state. Left stamped, a cancelled row named
      // the worker still holding it and carried that attempt's lease deadline — the pair
      // `x jobs show` prints, and the pair the claim scan reads to decide a row was abandoned.
      settle(jobId, {
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

    // `async` for the reason `claim`, `list` and `deadLetters` are: `onConflict: 'error'` REJECTS
    // here exactly as the pg driver's does, and a synchronous throw out of a method typed
    // `Promise<…>` is a second answer to one question — caught by different code, and an
    // unhandled exception rather than a settled promise wherever the caller holds the promise.
    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      // A caller-allocated id that already names a row is that row's publish, repeated: the same
      // job, whatever state it has reached — `SQL_ENQUEUE`'s `not exists` is the pg half.
      const published = request.id === undefined ? undefined : jobs.get(request.id);
      if (published !== undefined) {
        return { id: published.id, runId: published.runId, deduped: true };
      }
      const existing = liveByKey(request.name, request.idempotencyKey, request.tenantId);
      if (existing !== undefined) {
        if (request.onConflict === 'error') {
          throw new JobDuplicateError({
            job: request.name,
            idempotencyKey: request.idempotencyKey,
            existingId: existing.id,
          });
        }
        return { id: existing.id, runId: existing.runId, deduped: true };
      }

      const at = nowMs(clock);
      const runAt = request.runAt ?? at;
      const record: JobRecord = {
        id: request.id ?? uuid(),
        name: request.name,
        queue: request.queue || DEFAULT_QUEUE,
        // Through JSON, exactly as the pg driver binds it (`JSON.stringify(request.input ?? null)`):
        // a live reference kept a `Date`, an `undefined` member and a non-enumerable property the
        // queue in production never stores, so a job that read one passed here and failed there.
        input: JSON.parse(JSON.stringify(request.input ?? null)) as unknown,
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
      return { id: record.id, runId: record.runId, deduped: false };
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
        // A paused queue is never claimed — `SQL_CLAIM`'s `not exists` over `x_job_pauses`.
        .filter((record) => !operator.isQueuePaused(record.queue))
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
      const buried: JobRecord[] = [];
      for (const record of claimable) {
        // `SQL_CLAIM`'s second arm. A `running` row reaches this loop only with a lapsed lease, and
        // one that lapsed on its FINAL attempt has nothing left to be re-delivered for: handing
        // it out was an attempt past `maxAttempts`, every lease, forever — a job that kills its
        // worker took one per visibility timeout and never reached the dead-letter queue.
        if (
          record.state === 'running' &&
          isFinalAttempt({ attempts: record.maxAttempts }, record.attempt)
        ) {
          // `$5` of the statement: a job declaring `retry.deadLetter: false` is dropped.
          const state = claimOptions.dropExhausted?.includes(record.name) ? 'failed' : 'dead';
          settle(record.id, { state, lastError: LEASE_LAPSED_FINAL_ATTEMPT }, 'stack');
          operator.counters.add(record.name, state, 0, at);
          const dead = jobs.get(record.id);
          if (dead !== undefined) buried.push(dead);
          continue;
        }
        const claimed: ClaimedJob = {
          ...record,
          state: 'running',
          attempt: record.attempt + 1,
          claimedBy: claimOptions.workerId,
          claim: (record.claim ?? 0) + 1,
          claimedAt: at,
          visibleAt: at + claimOptions.visibilityTimeoutMs,
          updatedAt: at,
        };
        jobs.set(record.id, claimed);
        out.push(claimed);
      }
      if (buried.length > 0) claimOptions.onExhausted?.(buried);
      return out;
    },

    // Both settlements are FENCED on `running` AND on the claimer, as `SQL_ACK`/`SQL_NACK` are: an
    // ack from a worker whose job was cancelled — or whose lease lapsed and whose job another
    // worker re-claimed — would otherwise overwrite a row it no longer owns. The counter moves in
    // the same step as the row, so the two cannot disagree.
    ack(jobId: string, by: AckOptions): Promise<boolean> {
      const record = heldBy(jobId, by);
      if (record === undefined) return Promise.resolve(false);
      settle(jobId, { state: 'done' });
      if (by.counted !== false) {
        operator.counters.add(record.name, 'done', by.durationMs ?? 0, nowMs(clock));
      }
      return Promise.resolve(true);
    },

    nack(jobId: string, nackOptions: NackOptions): Promise<boolean> {
      const record = heldBy(jobId, nackOptions);
      if (record === undefined) return Promise.resolve(false);
      const at = nowMs(clock);
      const counts = nackOptions.countsAsAttempt !== false;
      const patch: Partial<JobRecord> = {
        // `park`, never `counts`: parking is what leaves the ready bucket, and burning an attempt
        // is a separate fact. A shed sets neither and stays `ready`, which is what it is.
        state: nackState(nackOptions),
        runAt: at + nackOptions.delayMs,
        // A suspension must not burn an attempt, or a 3-day sleep dead-letters the run. Floored
        // where `SQL_NACK` floors it (`greatest(attempt - 1, 0)`): the fence above is what keeps
        // the decrement paired with a claim today, so this is the guard that survives the fence
        // being read as the only one.
        attempt: counts ? record.attempt : Math.max(0, record.attempt - 1),
        ...(nackOptions.error === undefined ? {} : { lastError: nackOptions.error }),
        // The stack belongs to the ERROR beside it, as `SQL_NACK` binds it: no error, no stack.
        ...(nackOptions.error === undefined || nackOptions.stack === undefined
          ? {}
          : { lastErrorStack: nackOptions.stack.slice(0, MAX_ERROR_STACK_LENGTH) }),
      };
      settle(jobId, patch, nackOptions.error === undefined ? undefined : 'stack');
      const outcome = nackOutcome(nackOptions);
      if (outcome !== undefined) {
        operator.counters.add(record.name, outcome, nackOptions.durationMs ?? 0, at);
      }
      return Promise.resolve(true);
    },

    heartbeat(jobId: string, heartbeatOptions: HeartbeatOptions): Promise<boolean> {
      const record = jobs.get(jobId);
      // The same predicate `SQL_HEARTBEAT` carries. `false` is how an external cancel reaches a
      // job that is already running: the worker's next renewal misses and the attempt is aborted.
      if (
        record === undefined ||
        record.state !== 'running' ||
        (heartbeatOptions.workerId !== undefined &&
          record.claimedBy !== heartbeatOptions.workerId) ||
        (heartbeatOptions.claim !== undefined && record.claim !== heartbeatOptions.claim)
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
          failed: 0,
          dead: 0,
          oldestReadyMs: 0,
        };
        const next = { ...current };
        // Due is due, whatever state the row was WRITTEN in: a job enqueued `delayed` stays
        // `delayed` once its `runAt` passes (the claim scan reads `runAt`, nothing rewrites the
        // state), and counted by state it never reached `ready` or `oldestReadyMs` — the backlog
        // the autoscaler reads. `SQL_STATS` makes the same split.
        const waiting = record.state === 'ready' || record.state === 'delayed';
        if (waiting && record.runAt <= at) {
          next.ready += 1;
          next.oldestReadyMs = Math.max(next.oldestReadyMs, at - record.runAt);
        } else if (waiting) next.delayed += 1;
        else if (record.state === 'running') next.running += 1;
        else if (record.state === 'suspended') next.suspended += 1;
        else if (record.state === 'failed') next.failed += 1;
        else if (record.state === 'dead') next.dead += 1;
        byQueue.set(record.queue, next);
      }
      // Code units, as `collate "C"` orders them in `SQL_STATS` — never `localeCompare`, which
      // answers by the runtime's locale and so differently from the database on the same names.
      return Promise.resolve(
        [...byQueue.values()].sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0)),
      );
    },

    close(): Promise<void> {
      jobs.clear();
      return Promise.resolve();
    },
  };
}
