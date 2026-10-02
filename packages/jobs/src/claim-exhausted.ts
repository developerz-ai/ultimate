// The claim round's half of a burial: a row the claim settled `dead` (`ClaimOptions.onExhausted`)
// has no body to end it and no settle to announce it, so the pass that buried it says so — one log
// line an operator can alert on, and the job's `onSettled`, exactly as a dead letter a worker
// settled itself would get.

import type { Ctx } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import type { JobRecord } from './driver';
import { getJob } from './job';
import { announceSettled } from './settled';

export interface AnnounceExhaustedOptions {
  /** What `onExhausted` handed this pass — every row the claim buried, as it now stands. */
  readonly exhausted: readonly JobRecord[];
  readonly workerId: string;
  /** The worker's own context: what the job's `onSettled` is scoped from, as a body would be. */
  readonly context: () => Ctx;
}

/** What one pass buried, by how each row ended — what the worker's own counters take. */
export interface ExhaustedCounts {
  readonly deadLettered: number;
  readonly dropped: number;
}

/**
 * Announce every row one claim pass buried, and answer how each ended. Once per row, because the
 * claim buries a row once: the statement that settled it is the only one that hands it to
 * `onExhausted`. A row buried `failed` is a job declaring `retry.deadLetter: false`
 * (`ClaimOptions.dropExhausted`) — `dropped`, as its own nack would have ended it. Never rejects:
 * `announceSettled` owns a hook's failure, and a `context()` that throws is logged.
 */
export async function announceExhausted(
  options: AnnounceExhaustedOptions,
): Promise<ExhaustedCounts> {
  let dropped = 0;
  for (const record of options.exhausted) {
    const error = record.lastError ?? '';
    const outcome = record.state === 'failed' ? 'dropped' : 'dead-lettered';
    if (outcome === 'dropped') dropped += 1;
    // `error`, not `warn`: nobody recovered from this one, and a job that outlives every worker
    // that takes it is a crash loop somebody has to look at.
    logger.error('jobs.claim.exhausted', {
      workerId: options.workerId,
      job: record.name,
      jobId: record.id,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      outcome,
      error,
    });
    const handle = getJob(record.name);
    if (handle === undefined) continue;
    let ctx: Ctx;
    try {
      ctx = options.context();
    } catch (raised) {
      // The app's own function, asked AFTER the row was settled: thrown, it failed the round.
      logger.error('jobs.claim.exhausted-unannounced', {
        workerId: options.workerId,
        job: record.name,
        jobId: record.id,
        error: renderThrowable(raised),
      });
      continue;
    }
    await announceSettled({
      handle,
      claimed: record,
      ctx,
      // No code: nothing was thrown, and `JobFailed.code` is never invented.
      settlement: { outcome, error, code: undefined },
    });
  }
  return { deadLettered: options.exhausted.length - dropped, dropped };
}
