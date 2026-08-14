// One claimed job's lease: the heartbeat that renews it, and the fact no driver reports — that
// renewals stopped landing long enough for the queue to hand this job to another worker. A lease
// that lapses in silence is one job running twice with nothing in the log saying so, which is the
// hardest bug in a queue to see from the outside and the easiest to name from in here.

import type { Clock } from '@ultimat3/core';
import { logger, recordLeaseLost } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver } from './driver';

export interface LeaseHeartbeatOptions {
  /** Only `heartbeat` is used — a lease renews itself and settles nothing. */
  readonly driver: Pick<JobDriver, 'heartbeat'>;
  readonly claimed: ClaimedJob;
  readonly visibilityTimeoutMs: number;
  readonly intervalMs: number;
  readonly workerId: string;
  readonly clock?: Clock;
}

export interface LeaseHeartbeat {
  /** One renewal. The interval drives it; tests drive it instead of the timer. */
  renew(): Promise<void>;
  /** True once the lease lapsed: the queue may already have delivered this job again. */
  lost(): boolean;
  /** Stop renewing. Idempotent. */
  stop(): void;
}

/**
 * Start renewing the lease `claim()` bought, and say so out loud when renewal stops working.
 *
 * The lease is measured on THIS process's clock, not on `claimed.visibleAt`: that timestamp comes
 * from the driver's clock, and comparing the two makes every lease decision a function of clock
 * skew. Measured from the moment renewal started, the window can only ever be read as shorter than
 * it really is — reporting late is safe, reporting early would cry loss over a live lease.
 */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeat {
  const { claimed, visibilityTimeoutMs, workerId } = options;
  const now = (): number => nowMs(options.clock);
  let renewedAt = now();
  let renewing = false;
  let lost = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const lapsed = (): boolean => now() - renewedAt >= visibilityTimeoutMs;

  /**
   * Reported once, then renewal stops. Once the window is gone this job is claimable by anyone,
   * so a further renewal would extend a lease this process no longer holds — and a counter that
   * ticked once per interval would count intervals, not jobs.
   */
  const reportLost = (error?: unknown): void => {
    if (lost) return;
    lost = true;
    stop();
    logger.error('jobs.lease.lost', {
      workerId,
      job: claimed.name,
      jobId: claimed.id,
      queue: claimed.queue,
      attempt: claimed.attempt,
      visibilityTimeoutMs,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    });
    recordLeaseLost(claimed.queue);
  };

  const renew = async (): Promise<void> => {
    if (lost) return;
    // Expiry is decided BEFORE the driver is asked, because the failure that loses a lease most
    // quietly is the one that never answers: a heartbeat hung on a dead connection neither
    // resolves nor rejects, so a check that ran only on rejection would never run at all.
    if (lapsed()) {
      reportLost();
      return;
    }
    // One renewal in flight at a time. A driver slower than the interval would otherwise stack a
    // request per tick onto the connection that is already the thing failing.
    if (renewing) return;
    renewing = true;
    try {
      await options.driver.heartbeat(claimed.id, { visibilityTimeoutMs });
      // Asked again AFTER the call, because a renewal that SUCCEEDS late is still late: an
      // event-loop stall or a driver that answered at the end of a connect timeout can land this
      // past the window it was renewing, and `renewedAt = now()` there would restart the clock on
      // a lease the queue has already re-delivered — the loss hidden by the very call meant to
      // prevent it.
      if (lapsed()) {
        reportLost();
        return;
      }
      renewedAt = now();
    } catch (error) {
      // One failed renewal is not a lost lease: there is a whole visibility window left to land
      // the next one, and the default interval gives three tries inside it. Say it at warn and
      // let the window decide.
      logger.warn('jobs.heartbeat.failed', {
        workerId,
        job: claimed.name,
        jobId: claimed.id,
        attempt: claimed.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (lapsed()) reportLost(error);
    } finally {
      renewing = false;
    }
  };

  timer = setInterval(() => {
    void renew();
  }, options.intervalMs);

  return { renew, lost: () => lost, stop };
}
