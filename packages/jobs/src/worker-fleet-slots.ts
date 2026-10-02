// The fleet slot an in-flight job holds: `job.concurrency` as a row per HELD SLOT in the driver's
// lease store, taken at claim time, renewed while the job runs and handed back when it settles.
// Apart from `worker.ts` because the claim loop's question is "may I start this one?" — which job
// holds which slot, and who gives it back, is bookkeeping of its own.

import { logger, renderThrowable } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { ConcurrencyUnenforceableError } from './errors-concurrency';
import { getJob, registeredJobs } from './job';
import type { HeldLease, LeaseStore } from './leases';
import { jobLeaseKey } from './leases';
import { type IntervalScheduler, startRenewalTimer } from './renewal-timer';

/**
 * A renewal that REJECTED is not a lost slot: there is a TTL behind it and the interval gets
 * several tries inside it, exactly as `heartbeat.ts` treats a failed `driver.heartbeat`. The
 * heartbeat cannot cover for this one either way — it renews `x_jobs.visible_at`, a different row
 * on a different clock, and knows nothing about `x_job_leases`.
 */
const noop = (): void => undefined;

export interface FleetSlotOptions {
  /** The driver's lease store, or `undefined` for a driver that ships none. */
  readonly leases: LeaseStore | undefined;
  readonly workerId: string;
  /**
   * How long a fleet slot survives without renewal. The worker passes its visibility timeout, so
   * a worker that is SIGKILLed gives its slot back on exactly the schedule the queue gives its job
   * back — a longer TTL would leave `concurrency: 1` unfillable while the job it guarded is
   * already re-delivered.
   */
  readonly ttlMs: number;
  readonly renewIntervalMs: number;
  /** What every renewal runs on (`renewal-timer.ts`). Default: a real, unrefed interval. */
  readonly schedule?: IntervalScheduler;
}

/**
 * What the claim loop does with one claimed job. `wait` and `fail` are the two `whenBusy` answers
 * to a full cap — a plain number always waits. `undecidable` is a keyed job whose key could not
 * be derived: it holds no slot, so it must not run, and `error` is what the attempt fails with.
 */
export type SlotGrant =
  | { readonly outcome: 'granted' }
  | { readonly outcome: 'wait'; readonly limit: number; readonly key: string | undefined }
  | { readonly outcome: 'fail'; readonly limit: number; readonly key: string }
  | { readonly outcome: 'undecidable'; readonly error: unknown };

const GRANTED: SlotGrant = Object.freeze({ outcome: 'granted' });

/** The `holder` a slot is taken under. The job id is LAST, which is what `heldByRun` reads. */
const slotHolder = (workerId: string, jobId: string): string => `${workerId}:${jobId}`;

/** Whether `holder` is some claim of this same job — this worker's, or the one it replaced. */
const heldByRun = (holder: string, jobId: string): boolean => holder.endsWith(`:${jobId}`);

/**
 * The boot refusal: a driver with no lease store can only hold a cap per PROCESS, plain or keyed,
 * so the fleet would run `concurrency x replicas`. Refused rather than logged — a declared
 * guarantee that silently does nothing is what axiom 3 exists to make impossible.
 */
export function assertConcurrencyEnforceable(driver: JobDriver): void {
  if (driver.leases !== undefined) return;
  const capped = registeredJobs().filter((handle) => handle.concurrency !== undefined);
  if (capped.length === 0) return;
  throw new ConcurrencyUnenforceableError({
    driver: driver.name,
    jobs: capped.map((handle) => handle.name),
  });
}

export interface FleetSlots {
  /**
   * A fleet slot for this job's declared `concurrency` — per key when the cap is keyed — or what
   * to do without one. `granted` is also the answer for "no cap declared": a job with no
   * `concurrency` never touches the lease table.
   *
   * A driver with no lease store cannot reach here: `createWorker().start()` refuses to boot when
   * a registered job declares `concurrency` and the driver has none, because a cap that silently
   * holds per process is the documented-guarantee-that-does-nothing axiom 3 exists to make
   * impossible.
   */
  acquire(claimed: ClaimedJob): Promise<SlotGrant>;
  /**
   * Keeps this job's slot alive until the returned stop is called. A no-op when it holds none.
   *
   * `onLost` fires once, when a renewal comes back `false` — this worker no longer holds the slot,
   * either because another holder took it (this run and that one are both live under a cap of one)
   * or because it lapsed and is now free for anyone's next `acquire`. Both drivers answer `false`
   * to both cases; the pg statement fenced only on the holder until 2026-08, so a lapsed slot
   * revived itself there and cancelled the run under `x dev`. The caller cancels the run on it;
   * renewal stops here either way, because extending a slot this worker no longer holds would push
   * out somebody else's expiry.
   */
  startRenewal(jobId: string, onLost?: (slot: HeldLease) => void): () => void;
  release(jobId: string): Promise<void>;
}

export function createFleetSlots(options: FleetSlotOptions): FleetSlots {
  /** The fleet slot each in-flight job holds, so the renewal finds it and the drain frees it. */
  const held = new Map<string, HeldLease>();

  return {
    async acquire(claimed) {
      const handle = getJob(claimed.name);
      const limit = handle?.concurrency;
      const leases = options.leases;
      if (handle === undefined || limit === undefined || leases === undefined) return GRANTED;

      let key: string | undefined;
      try {
        // Parsed HERE as well as in `executeJob`: the key is a function of the input the body
        // will be handed, and a row the schema no longer accepts has no key to count under.
        if (handle.whenBusy !== undefined)
          key = handle.concurrencyKeyFor(handle.parse(claimed.input));
      } catch (error) {
        // Answered, never thrown: a throw here fails the whole claim ROUND, which hands this job
        // back uncounted — so one row with a bad key would stall its queue on every pass.
        return { outcome: 'undecidable', error };
      }

      const leaseKey = jobLeaseKey(claimed.name, key);
      const slot = await leases.acquire(
        leaseKey,
        limit,
        options.ttlMs,
        slotHolder(options.workerId, claimed.id),
      );
      if (slot !== undefined) {
        held.set(claimed.id, slot);
        return GRANTED;
      }
      if (handle.whenBusy !== 'fail' || key === undefined) return { outcome: 'wait', limit, key };

      // `'fail'` needs EVIDENCE that another run holds the key. A slot is released a moment after
      // its job is nacked and expires a moment after its job's lease, so a retried, resumed or
      // redelivered run can find its own previous claim still on the row — and a key nobody holds
      // any more is simply free on the next pass. Both wait; only somebody else's run refuses.
      const holders = await leases.holders(leaseKey);
      const others = holders.filter((holder) => !heldByRun(holder, claimed.id));
      return others.length === holders.length && others.length > 0
        ? { outcome: 'fail', limit, key }
        : { outcome: 'wait', limit, key };
    },

    startRenewal(jobId, onLost) {
      const slot = held.get(jobId);
      if (slot === undefined) return noop;
      // Renewed on the lease heartbeat's own interval and released in the same `finally`: one
      // clock for "this worker still owns the job" and "this worker still owns the slot" is one
      // fewer way for them to disagree — and `timer.stopped()` is the same latch `heartbeat.ts`
      // reads, for the same reason.
      const timer = startRenewalTimer(
        options.renewIntervalMs,
        () =>
          options.leases
            ?.renew(slot, options.ttlMs)
            .then((renewed) => {
              // `=== false`, never `!renewed`, for the reason `heartbeat.ts` reads `held` that way:
              // a store written before this return value existed resolves `undefined`, and treating
              // that as a loss would cancel every job on every renewal. Only an explicit no is one.
              //
              // `stopped()` re-read AFTER the await for the other half: the run settles, this timer
              // is stopped and `worker.ts` releases the slot — so the renewal already on the wire
              // finds the row gone and answers `false` for a job that FINISHED. Reported, that is
              // `jobs.worker.slot-lost` at error and an abort on a controller `runSignal.dispose()`
              // has already torn down: noise about a run nobody lost.
              if (renewed !== false || timer.stopped()) return;
              timer.stop();
              logger.error('jobs.worker.slot-lost', {
                workerId: options.workerId,
                jobId,
                leaseKey: slot.key,
                slot: slot.slot,
              });
              onLost?.(slot);
            })
            .catch(noop),
        options.schedule,
      );
      return () => timer.stop();
    },

    async release(jobId) {
      const slot = held.get(jobId);
      if (slot === undefined) return;
      held.delete(jobId);
      // Never lets a settle fail over bookkeeping: an unreleased slot expires on its own TTL.
      await options.leases?.release(slot).catch((error: unknown) => {
        logger.warn('jobs.worker.lease-release-failed', {
          workerId: options.workerId,
          jobId,
          error: renderThrowable(error),
        });
      });
    },
  };
}
