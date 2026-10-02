// "May this claimed job start?" — the two caps a claim passes before its body runs: the
// in-process limiter and the fleet slot, and what happens to a job that passes neither. Split off
// `worker.ts` at the size ceiling: that file is the claim loop and the drain, and this is the one
// decision the loop asks per job.

import type { Clock, Ctx } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { claimOf } from './driver';
import type { JobExecution } from './execute';
import type { Lease, Limiter } from './limits';
import type { FleetSlots, SlotGrant } from './worker-fleet-slots';
import { handBack } from './worker-hand-back';
import { refuseKeyBusy } from './worker-key-busy';

export interface AdmissionOptions {
  readonly driver: JobDriver;
  readonly limiter: Limiter;
  readonly fleetSlots: FleetSlots;
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly clock?: Clock;
  /** `WorkerOptions.context` — a refused run's `onSettled` is scoped from it. */
  readonly context: () => Ctx;
}

/**
 * `run`: start it, holding `lease` (and the fleet slot `fleetSlots` recorded). `refusal` is a key
 * that could not be derived — the run starts and `executeJob` fails the attempt before the body.
 * `waiting`: handed back, nothing to do. `refused`: settled `failed` here, its body never started.
 */
export type Admission =
  | { readonly kind: 'run'; readonly lease: Lease; readonly refusal?: unknown }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly execution: JobExecution };

/** `behind` is the rest of the claimed batch: handed back before a store failure is rethrown. */
export type Admit = (
  job: ClaimedJob,
  queue: string,
  behind: readonly ClaimedJob[],
) => Promise<Admission>;

export function createAdmission(options: AdmissionOptions): Admit {
  const { driver, limiter, fleetSlots, workerId, pollIntervalMs } = options;
  const back = { delayMs: pollIntervalMs, workerId };

  /**
   * A claimed job handed straight back over a cap. It is NOT a suspension and NOT a failure: no
   * `park`, so the row stays where `queue_depth` and `queue_oldest_ready_seconds` can see it, and
   * no `error`, so `x jobs show` does not report a `lastError` for a job that never ran. It was
   * both of those until 2026-08 — parked beside a 3-day `step.sleep`, and stamped with a failure
   * it never had — which is why the two sheds go through one function now.
   */
  const shed = async (claimed: ClaimedJob, queue: string, reason: string): Promise<void> => {
    logger.debug('jobs.worker.shed', {
      workerId,
      job: claimed.name,
      jobId: claimed.id,
      queue,
      reason,
    });
    await driver.nack(claimed.id, {
      ...claimOf(claimed),
      delayMs: pollIntervalMs,
      countsAsAttempt: false,
    });
  };

  return async (job, queue, behind) => {
    const key = { queue, ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }) };
    const lease = limiter.tryAcquire(key);
    if (lease === undefined) {
      // Over a tenant/queue/global cap: hand it straight back for another worker. The reason is a
      // log FIELD, where it costs nothing when nobody is asking.
      try {
        await shed(job, queue, limiter.blockedBy(key) ?? 'unknown');
      } catch (error) {
        // The nack itself failed: the jobs BEHIND it go back before the round reports.
        await handBack(driver, behind, back);
        throw error;
      }
      return { kind: 'waiting' };
    }

    // `job.concurrency`. The limiter above counts slots in THIS heap, which twenty pods multiply
    // by twenty; this one is a row every replica sees. Taken after the in-process lease so the
    // cheap refusal happens first.
    //
    // The `try` is the whole of a bug this had: taking a fleet slot is a WRITE to `x_job_leases`,
    // so a failover, a pool timeout or a `57P01` REJECTS here — between the in-process lease above
    // and the `.finally` that gives it back. The slot was burned permanently, and four of them on
    // a concurrency-4 worker is the whole role dead, silent but for `jobs.worker.tick-failed`.
    let grant: SlotGrant;
    try {
      grant = await fleetSlots.acquire(job);
    } catch (error) {
      lease.release();
      // This job and every one behind it go BACK, unburned — rethrowing alone stranded them in
      // `running` with an attempt spent on work that never started.
      await handBack(driver, [job, ...behind], back);
      throw error;
    }
    if (grant.outcome === 'granted') return { kind: 'run', lease };
    // A key that could not be derived RUNS — into `executeJob`'s failure path, which raises the
    // refusal before the body: it fails as an attempt, never as a round.
    if (grant.outcome === 'undecidable') return { kind: 'run', lease, refusal: grant.error };

    lease.release();
    try {
      // The two `whenBusy` answers. `'fail'` settles the run here, its body never started.
      if (grant.outcome === 'fail') {
        const execution = await refuseKeyBusy({
          driver,
          claimed: job,
          key: grant.key,
          limit: grant.limit,
          workerId,
          context: options.context,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        });
        return { kind: 'refused', execution };
      }
      const keyed = grant.key === undefined ? '' : `, key ${grant.key}`;
      await shed(job, queue, `job concurrency (${grant.limit}${keyed})`);
    } catch (error) {
      await handBack(driver, behind, back);
      throw error;
    }
    return { kind: 'waiting' };
  };
}

export interface ClaimAsk {
  readonly queues: readonly string[];
  readonly limit: number;
}

/**
 * What one pass asks the queue for. While there is work: one claim per queue, each for that
 * queue's own free slots — which is what keeps a slow queue from starving the others. While
 * IDLING: ONE statement over every queue with a free slot, for the fewest any of them has free,
 * so an empty pass costs one round trip however many queues the worker serves — a queue no job is
 * registered on included — and can never over-fill one.
 */
export function claimAsks(
  queues: readonly string[],
  freeSlots: (queue: string) => number,
  idle: boolean,
): readonly ClaimAsk[] {
  const open = queues
    .map((queue) => ({ queue, free: Math.max(0, freeSlots(queue)) }))
    .filter((entry) => entry.free > 0);
  if (!idle || open.length < 2) {
    return open.map((entry) => ({ queues: [entry.queue], limit: entry.free }));
  }
  return [
    {
      queues: open.map((entry) => entry.queue),
      limit: Math.min(...open.map((entry) => entry.free)),
    },
  ];
}
