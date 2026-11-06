// `resolveStep`'s one rule, shared by both drivers so they refuse alike: the job must exist and be
// held by no worker, and the step must have started (or failed) without completing. What the
// resolution writes — `completed` with the output, or `cleared` — is built here too.

import type { JobRecord } from './driver';
import { JobNotFoundError } from './errors-requeue';
import { StepNotResolvableError } from './errors-saga';
import type { StepResolution } from './introspection';
import { RESOLVABLE_STEP_STATUSES } from './introspection';
import type { StepRecord } from './steps-store';

/** Throws unless `record` of `job` may be resolved; answers the pair narrowed when it may. */
export function assertResolvable(
  driver: string,
  jobId: string,
  step: string,
  job: JobRecord | undefined,
  record: StepRecord | undefined,
): asserts job is JobRecord {
  if (job === undefined) throw new JobNotFoundError({ jobId, driver });
  const status = record?.status ?? 'missing';
  if (job.state === 'running' || !RESOLVABLE_STEP_STATUSES.has(status)) {
    throw new StepNotResolvableError({ jobId, step, state: job.state, status });
  }
}

/** The record a resolution writes over `record`, at `at` (epoch ms). */
export function resolvedRecord(
  record: StepRecord,
  resolution: StepResolution,
  at: number,
): StepRecord {
  const { output: _output, error: _error, completedAt: _completedAt, ...kept } = record;
  return resolution.ran
    ? { ...kept, status: 'completed', output: resolution.output ?? null, completedAt: at }
    : { ...kept, status: 'cleared' };
}
