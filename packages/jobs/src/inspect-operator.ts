// The operator verbs `x jobs` and a dashboard bind to: remove, promote, pause, resume, resolve a
// step. Each one refuses LOUDLY rather than answering "nothing happened" — an operator has to
// know whether the job is gone or was never theirs to remove. Apart from `inspect.ts`, which is
// the read side.

import type { JobDriver, JobRecord } from './driver';
import { JobNotPromotableError } from './errors-operator';
import { JobIntrospectionUnsupportedError, requireIntrospection } from './inspect-unsupported';
import type { PausedName, StepResolution } from './introspection';
import type { StepRecord } from './steps-store';

const operatorOf = requireIntrospection;

/** `undefined` for an id nobody queued; `X_JOB_NOT_REMOVABLE` for one a worker holds. */
export function removeJob(driver: JobDriver, jobId: string): Promise<JobRecord | undefined> {
  return operatorOf(driver).remove(jobId);
}

/** The promoted row. A job not waiting on its run time is `X_JOB_NOT_PROMOTABLE`, state named. */
export async function promoteJob(driver: JobDriver, jobId: string): Promise<JobRecord> {
  const operator = operatorOf(driver);
  const promoted = await operator.promote(jobId);
  if (promoted !== undefined) return promoted;
  const current = await operator.job(jobId);
  throw new JobNotPromotableError({ jobId, state: current?.state ?? 'missing' });
}

/** Pause, then read back: the answer is the list as the queue now holds it. */
export async function pauseQueue(driver: JobDriver, queue: string): Promise<readonly PausedName[]> {
  const operator = operatorOf(driver);
  await operator.pauseQueue(queue);
  return operator.pausedQueues();
}

export async function resumeQueue(
  driver: JobDriver,
  queue: string,
): Promise<readonly PausedName[]> {
  const operator = operatorOf(driver);
  await operator.resumeQueue(queue);
  return operator.pausedQueues();
}

/**
 * A person's answer to `X_STEP_OUTCOME_UNKNOWN`: the resolved record. Then `x jobs retry <id>`.
 * A hand-rolled surface with no `resolveStep` is refused by the same code as one with no surface.
 */
export function resolveJobStep(
  driver: JobDriver,
  jobId: string,
  step: string,
  resolution: StepResolution,
): Promise<StepRecord> {
  const operator = operatorOf(driver);
  if (operator.resolveStep === undefined) {
    throw new JobIntrospectionUnsupportedError({ driver: driver.name, member: 'resolveStep' });
  }
  return operator.resolveStep(jobId, step, resolution);
}
