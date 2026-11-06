// The operator verbs `x jobs` and a dashboard bind to: remove, promote, pause, resume, resolve a
// step. Each one refuses LOUDLY rather than answering "nothing happened" — an operator has to
// know whether the job is gone or was never theirs to remove. Apart from `inspect.ts`, which is
// the read side.

import { NotImplementedError } from '@ultimat3/core';
import type { JobDriver, JobRecord } from './driver';
import { JobNotPromotableError } from './errors-operator';
import type { JobIntrospection, PausedName, StepResolution } from './introspection';
import type { StepRecord } from './steps-store';

function operatorOf(driver: JobDriver): JobIntrospection {
  if (driver.introspect === undefined) {
    throw new NotImplementedError({
      cause: `the operator surface of the "${driver.name}" jobs driver is not implemented: the driver has no introspect`,
      fix: 'call setJobDriver(postgresJobDriver()) at boot — the pg driver implements introspect — then: x jobs list --json',
    });
  }
  return driver.introspect;
}

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
 * A driver with no `resolveStep` is refused as one with no operator surface at all.
 */
export function resolveJobStep(
  driver: JobDriver,
  jobId: string,
  step: string,
  resolution: StepResolution,
): Promise<StepRecord> {
  const operator = operatorOf(driver);
  if (operator.resolveStep === undefined) {
    throw new NotImplementedError({
      cause: `the "${driver.name}" jobs driver keeps no step records an operator can resolve: its introspect has no resolveStep`,
      fix: 'setJobDriver(postgresJobDriver())   # at boot: the pg and memory drivers implement resolveStep — then x jobs resolve-step <id> <step> --ran --output <json>',
    });
  }
  return operator.resolveStep(jobId, step, resolution);
}
