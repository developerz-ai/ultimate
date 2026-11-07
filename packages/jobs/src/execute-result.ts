// What one attempt of `executeJob` answers: how it ended and what it left behind. Its own file so
// the worker, the metrics and the tally read the result's shape without the execution path.

import type { JobStopReason } from './retry-classification';
import type { StepRecord } from './steps';

/**
 * How one attempt ended. `interrupted` is the worker's drain cutting the attempt short: the job is
 * back in the ready bucket with the attempt UNCOUNTED, because the process ended it and not the
 * job — filed as `retried`, a deploy would burn an attempt per job it held, and with
 * `attempts: 1` dead-letter it. `dropped` is a run that failed for good on a job declaring
 * `retry.deadLetter: false`: the row is `failed`, where it used to go back `ready` and run
 * forever. `refused` is `whenBusy: 'fail'` over a busy concurrency key: the
 * row is `failed`, the body never ran, and it is neither a retry nor a dead letter
 * (`worker-key-busy.ts`).
 */
export type JobOutcome =
  | 'completed'
  | 'suspended'
  | 'retried'
  | 'dead-lettered'
  | 'dropped'
  | 'interrupted'
  | 'refused';

export interface JobExecution {
  readonly outcome: JobOutcome;
  readonly jobId: string;
  readonly job: string;
  readonly attempt: number;
  readonly durationMs: number;
  /** Epoch ms the row is claimable again: a suspension's wake, or a retry's backoff ending. */
  readonly resumeAt?: number;
  readonly error?: string;
  /** The stable `X_*` code the attempt's error carried — absent for an uncoded throw. */
  readonly code?: string;
  /** Why this attempt was the last. Absent while the job is still being retried. */
  readonly stopReason?: JobStopReason;
  /** What the body returned — present exactly on `completed`, for a caller driving a run by hand. */
  readonly result?: unknown;
  readonly steps: readonly StepRecord[];
  readonly replayed: readonly string[];
}
