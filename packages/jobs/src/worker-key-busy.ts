// One claimed run its concurrency key refused under `whenBusy: 'fail'`: settled `failed` with
// `X_JOB_KEY_BUSY`, its body never run. Apart from `execute.ts` because nothing is executed here —
// no attempt, no retry decision, no dead letter — and a refusal that travelled the failure path
// would be counted, reported and parked as a fault the author declared was an answer.

import type { Clock, Ctx } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, JobDriver } from './driver';
import { claimOf } from './driver';
import { JobKeyBusyError } from './errors-concurrency';
import type { JobExecution } from './execute';
import { getJob } from './job';
import { failureForRow } from './retry-classification';
import { announceSettled } from './settled';

export interface RefuseKeyBusyOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  readonly key: string;
  readonly limit: number;
  readonly workerId: string;
  readonly clock?: Clock;
  /** The worker's own context: what the job's `onSettled` is scoped from, as a body would be. */
  readonly context: () => Ctx;
}

/**
 * `fail: true`, so the row is terminal and out of the dead-letter queue, and
 * `countsAsAttempt: false`, because no attempt ran: `x jobs show` then reads the attempts the body
 * actually had, beside a `lastError` that says why there is not one more.
 *
 * Not `reportError`ed: the error tracker is for failures somebody has to look at, and this one
 * was asked for by the declaration. The row and this log line carry it.
 */
export async function refuseKeyBusy(
  options: RefuseKeyBusyOptions,
): Promise<JobExecution | undefined> {
  const { driver, claimed, key, limit } = options;
  const startedAt = nowMs(options.clock);
  const refusal = new JobKeyBusyError({ job: claimed.name, key, limit });
  const error = failureForRow(refusal);
  // Fenced on the claimer like every settle: a refusal from a worker whose claim lapsed must not
  // fail a run another worker has since been granted the key for.
  const settled = await driver.nack(claimed.id, {
    ...claimOf(claimed),
    delayMs: 0,
    error,
    countsAsAttempt: false,
    fail: true,
  });
  if (!settled) {
    // The claim lapsed and the row is another worker's now, or it was cancelled: nothing was
    // refused HERE, so there is no execution to count — `executeJob`'s own line for the same miss.
    logger.warn('jobs.settle.unowned', {
      job: claimed.name,
      jobId: claimed.id,
      workerId: options.workerId,
      settling: 'refused',
    });
    return undefined;
  }
  logger.info('jobs.attempt.refused', {
    workerId: options.workerId,
    job: claimed.name,
    jobId: claimed.id,
    key,
    limit,
  });
  // The one ending no body is there to record: "a second run was refused" exists for the app only
  // if the job is told. After the settle, like every other announcement.
  const handle = getJob(claimed.name);
  if (handle !== undefined) {
    let ctx: Ctx | undefined;
    try {
      ctx = options.context();
    } catch (raised) {
      // `context()` is the app's own function. The row is already settled `failed`: a throw from
      // here failed the whole claim ROUND over a refusal that had landed.
      logger.error('jobs.attempt.refused-unannounced', {
        workerId: options.workerId,
        job: claimed.name,
        jobId: claimed.id,
        error: renderThrowable(raised),
      });
    }
    if (ctx !== undefined) {
      await announceSettled({
        handle,
        claimed,
        ctx,
        settlement: { outcome: 'refused', error, code: refusal.code },
      });
    }
  }
  return {
    outcome: 'refused',
    jobId: claimed.id,
    job: claimed.name,
    attempt: claimed.attempt,
    durationMs: nowMs(options.clock) - startedAt,
    error,
    stopReason: 'terminal',
    steps: [],
    replayed: [],
  };
}
