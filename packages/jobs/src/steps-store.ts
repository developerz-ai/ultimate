// What a run's steps are stored as: the records, their status vocabulary, the fence a write is made
// under, and the store seam every driver implements. Split from `steps.ts` at the file-size ceiling:
// that file is the runner, this is what it writes through.

/**
 * The runtime list is the declaration and `StepStatus` is derived from it, the shape
 * `BACKFILL_STATUSES` and `PRIMITIVE_KINDS` already have. A bare union cannot narrow a `text`
 * column, so `driver-pg-rows.ts` cast one instead — and a cast that lands an unknown status on a
 * record makes `stepRun`'s `existing?.status === 'completed'` false, which RE-EXECUTES a step
 * this file promises runs once.
 */
export const STEP_STATUSES = ['completed', 'sleeping', 'waiting', 'failed'] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

/** Narrows a status read back out of a store. Never a cast — the list decides. */
export const isStepStatus = (value: string): value is StepStatus =>
  (STEP_STATUSES as readonly string[]).includes(value);

export interface StepRecord {
  readonly runId: string;
  readonly name: string;
  readonly status: StepStatus;
  /** The memoized return value. Present only when `status === 'completed'`. */
  readonly output?: unknown;
  readonly startedAt: number;
  readonly completedAt?: number;
  /** Epoch ms at which a sleeping/waiting step becomes runnable. */
  readonly wakeAt?: number;
  readonly event?: string;
  readonly correlationKey?: string;
  readonly attempts: number;
  readonly error?: string;
}

/** The claim a step write is made under: `claimOf(claimed)`, plus the row it names. */
export interface StepFence {
  readonly job: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly claim: number;
}

export interface StepStore {
  get(runId: string, name: string): Promise<StepRecord | undefined>;
  /**
   * With `by`, the write lands only while that claim still holds the row (`running`, same worker,
   * same claim ordinal — `SQL_ACK`'s fence) and is `X_JOB_LEASE_LOST` otherwise: the in-process
   * signal cannot stop a body in ANOTHER process whose lease lapsed. Without it the write is
   * unfenced — a transfer (`x jobs drain`) or a runner driven by hand, with no row to hold.
   */
  put(record: StepRecord, by?: StepFence): Promise<void>;
  list(runId: string): Promise<readonly StepRecord[]>;
  del(runId: string, name: string): Promise<void>;
  clear(runId: string): Promise<void>;
}
