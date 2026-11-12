// How a claim is SETTLED: the fence a settle carries (`SettleBy`), what a nack asks for and the one
// reading of the state it leaves (`nackState`), and the `onSettled` debt a settle may record
// (`SettleDebt`, J11). Split off `driver.ts` at its size ceiling; re-exported from it unchanged.

import type { ClaimIdentity, JobRecord, JobState } from './driver';

/**
 * Who settles a claim, and how long the attempt ran. The identity is the FENCE: a settle from a
 * claim the row no longer carries matches nothing. The lease lapses, the row is claimed again —
 * by another worker or by this one — and the first body unwinds: its ack would mark the second
 * run `done`, its nack would hand a running job to a third. `durationMs` feeds the per-minute
 * counters the same statement writes.
 */
export interface SettleBy extends ClaimIdentity {
  readonly durationMs?: number;
  /**
   * The job declares `onSettled`: a settle that ENDS the run (`done`, `dead`, `failed`) records
   * that the hook is owed, in the same write, and `SettleDebt.clear` pays it once the hook
   * returns. A retry, a suspension or a shed owes nothing whatever this says.
   */
  readonly owesSettle?: boolean;
}

/** An ack is a settle by the claimer: every ack is a completed run and adds to the counters. */
export type AckOptions = SettleBy;

export interface NackOptions extends SettleBy {
  /** Delay before the job becomes claimable again. */
  readonly delayMs: number;
  readonly error?: string;
  /** The thrown value's stack, kept beside `error` for `x jobs show`. */
  readonly stack?: string;
  /**
   * The ATTEMPT COUNTER, and nothing else. False for a suspension and for a shed alike: neither is
   * a failure, and a 3-day sleep that burned an attempt would dead-letter the job.
   */
  readonly countsAsAttempt?: boolean;
  /**
   * True for a SUSPENSION — `step.sleep`, or a name this deploy does not know — which leaves the
   * ready bucket and is counted `suspended`. Absent for a limiter or `job.concurrency` shed, which
   * is a job still WAITING to run.
   *
   * The two were one flag until 2026-08: `countsAsAttempt: false` decided the state as well as the
   * counter, so a shed was filed beside a 3-day sleep and `stats()` excluded it from `ready` and
   * from `oldestReadyMs` — the two numbers the worker publishes as `queue_depth` and
   * `queue_oldest_ready_seconds`. Under sustained overload the shed fraction approaches 100%, so
   * the HPA signal and the "oldest job older than 5 minutes" page both went quiet exactly when the
   * queue was saturated.
   */
  readonly park?: boolean;
  readonly deadLetter?: boolean;
  /**
   * Terminal WITHOUT the dead-letter queue: the row settles `failed` — finished, never claimed
   * again, requeueable by `x jobs retry`, and absent from `queue_dead_jobs`. For an ending that is
   * an answer rather than a fault: `whenBusy: 'fail'` over a busy concurrency key
   * (`X_JOB_KEY_BUSY`). `deadLetter` wins when both are set, and `park` loses to both.
   */
  readonly fail?: boolean;
}

/**
 * The state a nack leaves its row in — ONE reading, for every driver. It was a three-way written
 * out in each, which is two places for a fourth branch to land in one and not the other; a
 * `fail` the pg driver filed as `ready` would re-claim a refused run forever.
 */
export const nackState = (options: NackOptions): JobState =>
  options.deadLetter === true
    ? 'dead'
    : options.fail === true
      ? 'failed'
      : options.park === true
        ? 'suspended'
        : 'ready';

/** One job whose owed hooks may be re-driven, and how long a debt stands before it counts as lost. */
export interface SettleDebtJob {
  readonly name: string;
  /** A debt younger than this may still be paid by the worker that settled it. */
  readonly graceMs: number;
}

/**
 * The `onSettled` debt (J11): a settle records it, the hook's return clears it, and the scheduler
 * leader re-drives what a crash left between the two. Fenced on the claim ordinal, so a row an
 * operator requeued and a worker settled again is a new debt, never the old one paid.
 */
export interface SettleDebt {
  /** The hook of THIS settlement returned. Answers whether a debt was there to clear. */
  clear(jobId: string, claim: number): Promise<boolean>;
  /**
   * Up to `limit` ended rows of `jobs` whose debt is older than the job's grace, oldest first, and
   * TAKEN: each one's clock restarts, so a second pass inside the grace hands none of them out
   * again. A name not in `jobs` is never answered: this deploy has no hook to run for it.
   */
  takeLost(jobs: readonly SettleDebtJob[], limit: number): Promise<readonly JobRecord[]>;
}
