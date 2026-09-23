// Single responsibility: the two refusals `requeue` — `x jobs retry` — gives before it moves a
// row. Its own module because `errors.ts` sits at the size ceiling; the codes are registered there.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
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
