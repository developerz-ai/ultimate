// What a failed attempt makes visible beyond its own log line: the error tracker for a failure
// nobody recovered from, a counter for one the queue will retry. A tracker opens an issue and pages
// per event, so a retry reported there turned one expected, self-healing failure into six issues.

import type { Counter } from '@ultimat3/core';
import { counter, reportError } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import type { AnyJobHandle } from './job';
import type { JobStopReason } from './retry-classification';
import { settledCode } from './settled';

/**
 * One increment per retried attempt. `job` is bounded by the app's registry and `code` by its
 * error vocabulary; a thrown value with no code counts as `uncoded`, never as an absent label.
 */
export const jobsRetried: Counter = counter('jobs_retried_total', {
  unit: '{attempt}',
  description: 'Job attempts that failed and were handed back to the queue, by job and code',
});

export interface AttemptFailure {
  readonly handle: AnyJobHandle;
  readonly claimed: ClaimedJob;
  readonly error: unknown;
  readonly retry: boolean;
  readonly stop: JobStopReason | undefined;
}

/**
 * This package's ONE report of a failed attempt, called from the only frame that still holds the
 * thrown value (`executeJob`). A retry is counted, and reported only when the job declared
 * `retry.report: 'every-attempt'`; an attempt failed for good is always reported, as an `error`.
 */
export function reportAttemptFailure(failure: AttemptFailure): void {
  const { handle, claimed, error, retry, stop } = failure;
  if (retry) {
    jobsRetried.add(1, { job: handle.name, code: settledCode(error) ?? 'uncoded' });
    if (handle.retry.report !== 'every-attempt') return;
  }
  reportError(error, {
    source: 'job',
    severity: retry ? 'warning' : 'error',
    scope: {
      operation: handle.name,
      extra: {
        jobId: claimed.id,
        runId: claimed.runId,
        attempt: claimed.attempt,
        retry,
        ...(stop === undefined ? {} : { stop }),
      },
    },
  });
}
