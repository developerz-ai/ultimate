// Single responsibility: the three refusals `requeue` — `x jobs retry` — gives before it moves a
// row, raised identically by `driver-memory.ts` and `driver-pg.ts`: one answer for both drivers is
// the point, and neither driver imports the other. The codes are registered in `errors.ts`.

import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';
import { JobDuplicateError } from './errors';

/**
 * `x jobs retry` on a job that is still live. Requeueing a RUNNING row left `claimed_by` set with
 * state `ready`, so a second worker claimed it and it ran twice; a queued one has nothing to retry.
 */
export class JobNotRequeueableError extends UltimateError {
  constructor(input: { jobId: string; state: string }) {
    super({
      code: 'X_JOB_NOT_REQUEUEABLE',
      cause: `job ${input.jobId} is ${input.state}, and only a dead, cancelled, failed or done job can be requeued — a live one would run twice`,
      fix: `x jobs cancel ${renderFixShellArg(input.jobId, '<job id>')} first, then x jobs retry ${renderFixShellArg(input.jobId, '<job id>')}`,
      meta: { jobId: input.jobId, state: input.state },
    });
  }
}

/**
 * `requeue` of an id the queue does not hold. ONE answer for both drivers: memory raised
 * `X_INVARIANT` and pg `X_DRIVER_UNAVAILABLE` — a driver that is perfectly available — so a caller
 * could not tell a mistyped id from an outage, and tested against one answer on `x dev` and met
 * the other in production.
 */
export class JobNotFoundError extends UltimateError {
  constructor(input: { jobId: string; driver: string }) {
    super({
      code: 'X_JOB_NOT_FOUND',
      cause: `the "${input.driver}" queue holds no job with id ${renderCauseValue(input.jobId)} — a mistyped id, a job removed since, or an id from another environment`,
      fix: 'x jobs ls --json',
      meta: { jobId: input.jobId },
    });
  }
}

/** The error a requeue gives when a LIVE job already holds the requeued row's key. */
export const requeueKeyTaken = (record: {
  readonly id: string;
  readonly name: string;
  readonly idempotencyKey: string;
  readonly holderId: string;
}): JobDuplicateError =>
  new JobDuplicateError({
    job: record.name,
    idempotencyKey: record.idempotencyKey,
    existingId: record.holderId,
    fix: `x jobs show ${renderFixShellArg(record.holderId, '<live job id>')} — that is the live run of this key; cancel it first (x jobs cancel ${renderFixShellArg(record.holderId, '<live job id>')}) only if this one must run instead`,
  });
