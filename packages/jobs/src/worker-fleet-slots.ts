// The fleet slot an in-flight job holds: `job.concurrency` as a row per HELD SLOT in the driver's
// lease store, taken at claim time, renewed while the job runs and handed back when it settles.
// Apart from `worker.ts` because the claim loop's question is "may I start this one?" — which job
// holds which slot, and who gives it back, is bookkeeping of its own.

import { logger } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { getJob } from './job';
import type { HeldLease, LeaseStore } from './leases';
import { jobLeaseKey } from './leases';
import { startRenewalTimer } from './renewal-timer';

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
}

export interface FleetSlots {
  /**
   * A fleet slot for this job's declared `concurrency`, or `false` when the fleet is full.
   * `true` means "no cap declared" — a job with no `concurrency` never touches the lease table.
   *
   * A driver with no lease store cannot reach here: `createWorker().start()` refuses to boot when
   * a registered job declares `concurrency` and the driver has none, because a cap that silently
   * holds per process is the documented-guarantee-that-does-nothing axiom 3 exists to make
   * impossible.
   */
  acquire(claimed: ClaimedJob): Promise<boolean>;
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
      const limit = getJob(claimed.name)?.concurrency;
      if (limit === undefined || options.leases === undefined) return true;
      const slot = await options.leases.acquire(
        jobLeaseKey(claimed.name),
        limit,
        options.ttlMs,
        `${options.workerId}:${claimed.id}`,
      );
      if (slot === undefined) return false;
      held.set(claimed.id, slot);
      return true;
    },

    startRenewal(jobId, onLost) {
      const slot = held.get(jobId);
      if (slot === undefined) return noop;
      // Renewed on the lease heartbeat's own interval and released in the same `finally`: one
      // clock for "this worker still owns the job" and "this worker still owns the slot" is one
      // fewer way for them to disagree — and `timer.stopped()` is the same latch `heartbeat.ts`
      // reads, for the same reason.
      const timer = startRenewalTimer(options.renewIntervalMs, () =>
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
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
