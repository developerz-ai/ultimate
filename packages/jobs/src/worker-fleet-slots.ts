// The fleet slot an in-flight job holds: `job.concurrency` as a row per HELD SLOT in the driver's
// lease store, taken at claim time, renewed while the job runs and handed back when it settles.
// Apart from `worker.ts` because the claim loop's question is "may I start this one?" — which job
// holds which slot, and who gives it back, is bookkeeping of its own.

import { logger } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { getJob } from './job';
import type { HeldLease, LeaseStore } from './leases';
import { jobLeaseKey } from './leases';

/** A slot renewal that failed has a TTL behind it; the heartbeat is what reports a lost lease. */
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
  /** Keeps this job's slot alive until the returned stop is called. A no-op when it holds none. */
  startRenewal(jobId: string): () => void;
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

    startRenewal(jobId) {
      const slot = held.get(jobId);
      if (slot === undefined) return noop;
      // Renewed on the lease heartbeat's own interval and released in the same `finally`: one
      // clock for "this worker still owns the job" and "this worker still owns the slot" is one
      // fewer way for them to disagree.
      const timer = setInterval(() => {
        void options.leases?.renew(slot, options.ttlMs).catch(noop);
      }, options.renewIntervalMs);
      return () => {
        clearInterval(timer);
      };
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
