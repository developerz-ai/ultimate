// The queue contract. Every driver implements exactly this, so a job's code never names one.
// Six methods and no more: claim/ack/nack with a visibility timeout is the smallest set that
// survives a worker crash.
//
// This header used to say "switching backends is a config line" (`As of 2026-08`). There is no
// such config line: `JobsConfig.driver` has no reader anywhere and boot always builds
// `createPgDriver`. `pg` and `memory` are the two that exist; `redis` and `nats` are honest
// `X_NOT_IMPLEMENTED` stubs. What IS true is the second half — swapping the driver is
// `setJobDriver(other)` and ZERO job-code change — and that is what the interface buys.

import { finiteCount, finiteOption } from '@ultimat3/core';
import type { BackfillLedger } from './backfill-ledger';
import { ClaimQueuesEmptyError } from './errors';
import type { JobIntrospection, JobProgress } from './introspection';
import type { LeaseStore } from './leases';
import type { StepStore } from './steps';

/**
 * `cancelled` is terminal and is NOT `dead`: a dead letter is work that failed and can be retried,
 * a cancellation is work an operator stopped on purpose and `x jobs retry` must not resurrect by
 * accident. It appears in no claim predicate, so the queue never hands a cancelled row out again.
 */
export const JOB_STATES = [
  'ready',
  'delayed',
  'running',
  'suspended',
  'done',
  'failed',
  'dead',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/**
 * The states `requeue` — `x jobs retry` — accepts. Everything else is live: requeueing a running
 * row ran it twice, and a queued one has nothing to retry. `SQL_JOB_REQUEUE` fences on the same set.
 */
export const REQUEUEABLE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'dead',
  'cancelled',
  'done',
  'failed',
]);

/** Narrows a state read back off a queue row. Never a cast — the list decides. */
export const isJobState = (value: string): value is JobState =>
  (JOB_STATES as readonly string[]).includes(value);

export interface JobRecord {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  /** Dedupe key from the job definition. At-least-once delivery leans on this. */
  readonly idempotencyKey: string;
  /** Stable across retries and suspensions — the key every step record hangs off. */
  readonly runId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly state: JobState;
  /** Epoch ms; the job is invisible until then. */
  readonly runAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Actor's orgId, for per-tenant limits. */
  readonly tenantId?: string;
  readonly lastError?: string;
  /** The thrown value's stack for `lastError`, bounded (`MAX_ERROR_STACK_LENGTH`). */
  readonly lastErrorStack?: string;
  /** What the body last reported through `progress()` — see `introspection.ts`. */
  readonly progress?: JobProgress;
  readonly claimedBy?: string;
  /** How many times this row has been claimed. Absent until the first claim. */
  readonly claim?: number;
  readonly visibleAt?: number;
  /**
   * W3C `traceparent` of the request that queued this job. The job's span is opened as a CHILD of
   * it, so a checkout trace shows the HTTP span, the action span and the charge that ran two
   * seconds later as one trace rather than three unrelated roots.
   */
  readonly traceparent?: string;
  /** Actor id of whoever asked for this work. AUDIT ONLY — see `EnqueueRequest.enqueuedBy`. */
  readonly enqueuedBy?: string;
}

export type ConflictPolicy = 'dedupe' | 'error';

export interface EnqueueRequest {
  /**
   * The row's id, when the caller already allocated one. The outbox does, at STAGE time, so the
   * enqueue that staged it can name the job before it exists — and so a row published twice
   * meets the job its first publish made (`deduped: true`), live or finished, instead of
   * inserting a second one. Omit it everywhere else: the driver mints one.
   */
  readonly id?: string;
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  /** Epoch ms. Omit for "now". */
  readonly runAt?: number;
  readonly tenantId?: string;
  /**
   * The run's id — the key its steps, its events and its prompts hang off. Allocated by the
   * outbox at stage time or named by the caller (`EnqueueOptions.runId`); minted here otherwise.
   */
  readonly runId?: string;
  readonly onConflict?: ConflictPolicy;
  /** W3C `traceparent` of the enqueuing request. The facade stamps it; callers rarely set it. */
  readonly traceparent?: string;
  /**
   * Who asked for this work — an actor id, ATTRIBUTION AND NOT AUTHORITY.
   *
   * The framework picks one answer to "whose permissions does a job run with" and this is it: a
   * job body runs with SYSTEM authority and this column is an audit trail. The alternative —
   * resolving the enqueuer at claim time and impersonating them — is worse in exactly the case
   * that matters: a job that sleeps three days, or dead-letters and is retried next quarter, would
   * act as somebody whose role, org membership or employment has since changed. `02-primitives.md`
   * already calls a job server-authoritative work; this makes the row say so too. A job that must
   * act for a user takes that user's id in its INPUT and re-authorises it in the body, where the
   * check is visible.
   */
  readonly enqueuedBy?: string;
}

export interface EnqueueResult {
  readonly id: string;
  readonly runId: string;
  /** True when an in-flight job already held this idempotency key. */
  readonly deduped: boolean;
}

export interface ClaimOptions {
  /**
   * The queues this pass may take work from, by name. **At least one, and an empty list is
   * refused** (`X_JOB_CLAIM_QUEUES_EMPTY`) — see `assertClaimQueues`. `createWorker` passes exactly
   * one per pass, which is what keeps a slow queue from starving the others.
   */
  readonly queues: readonly string[];
  readonly limit: number;
  /** Lease length. A worker that dies without ack makes the job claimable again after this. */
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
}

export interface ClaimedJob extends JobRecord {
  readonly claimedAt: number;
  readonly visibleAt: number;
  /** The worker this claim was made for. */
  readonly claimedBy: string;
  /**
   * THIS claim, as the row's claim ordinal: 1 for the first, one more for each after it, never
   * reset. With `claimedBy` it is the identity every settle, renewal and progress write of this
   * claim is fenced on — `claimOf(claimed)` is how a caller carries the pair.
   */
  readonly claim: number;
}

/**
 * WHICH claim is acting. `workerId` alone was the fence, and it names a worker, not a claim: a
 * worker that takes back its own lapsed job is the same worker, so the body still unwinding from
 * the first claim settled the second. The ordinal is what tells the two apart.
 */
export interface ClaimIdentity {
  readonly workerId: string;
  readonly claim: number;
}

export const claimOf = (claimed: Pick<ClaimedJob, 'claimedBy' | 'claim'>): ClaimIdentity => ({
  workerId: claimed.claimedBy,
  claim: claimed.claim,
});

/**
 * Who settles a claim, and how long the attempt ran. The identity is the FENCE: a settle from a
 * claim the row no longer carries matches nothing. The lease lapses, the row is claimed again —
 * by another worker or by this one — and the first body unwinds: its ack would mark the second
 * run `done`, its nack would hand a running job to a third. `durationMs` feeds the per-minute
 * counters the same statement writes.
 */
export interface SettleBy extends ClaimIdentity {
  readonly durationMs?: number;
}

export interface AckOptions extends SettleBy {
  /**
   * False when the row is finished WITHOUT its body having run here — `x jobs drain` moving it to
   * another driver. It is settled `done` and adds nothing to the job's counters: a job that was
   * moved is not a job that completed.
   */
  readonly counted?: boolean;
}

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

export interface QueueStats {
  readonly queue: string;
  readonly ready: number;
  readonly delayed: number;
  readonly running: number;
  readonly suspended: number;
  /** Rows that ended `failed` — refused by a busy key, or exhausted with `deadLetter: false`. */
  readonly failed: number;
  readonly dead: number;
  /**
   * Age in ms of the oldest job that is READY and due — the number that decides autoscaling.
   * Not "claimable": a `suspended` row is claimable once its `runAt` passes and is deliberately
   * excluded here, which is exactly why a limiter shed may not be filed as a suspension.
   */
  readonly oldestReadyMs: number;
}

export interface HeartbeatOptions {
  readonly visibilityTimeoutMs: number;
  /** Renew only if this worker is still the claimant. Omit and any claimant matches. */
  readonly workerId?: string;
  /** Renew only if the row still carries THIS claim (`ClaimedJob.claim`). Omit and any does. */
  readonly claim?: number;
}

export interface JobDriver {
  readonly name: string;
  /** Step persistence lives with the queue: one store, one transaction boundary. */
  readonly steps: StepStore;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;
  /**
   * Both settles are fenced on `state = 'running'` AND on the claimer, and both answer whether
   * they LANDED. `false` is a settle from a worker that no longer owns the row — logged by the
   * caller, never thrown: the row is somebody else's now and theirs is the verdict.
   */
  ack(jobId: string, by: AckOptions): Promise<boolean>;
  nack(jobId: string, options: NackOptions): Promise<boolean>;
  /**
   * Extends the lease of a long-running job so it is not double-claimed.
   *
   * Answers whether the renewal LANDED. `false` means this process no longer owns the job — it
   * was cancelled, or its lease lapsed and another worker re-claimed it — and the caller must
   * stop running it. A `void` return made both indistinguishable from success, so an external
   * cancel had nothing to reach a running job with.
   */
  heartbeat(jobId: string, options: HeartbeatOptions): Promise<boolean>;
  stats(): Promise<readonly QueueStats[]>;
  /**
   * Optional, like `introspect`: `x_backfills` records what a `backfill()` pass has already swept,
   * and a driver without one runs backfills with no bookkeeping rather than refusing them. It
   * hangs here for the same reason `steps` does — durable state that ships in the queue's own DDL,
   * so one install point covers both.
   */
  readonly backfills?: BackfillLedger;
  /**
   * Optional, like `introspect` and `backfills`: fleet-wide slot counting, which is the only thing
   * that can make `job.concurrency` mean what its docstring says. The in-process limiter is a fast
   * path over ONE heap and is multiplied by the replica count; this is the gate that is not.
   * A driver without one can only hold the cap per process, so `createWorker().start()` THROWS
   * `X_JOB_CONCURRENCY_UNENFORCEABLE` (`worker.ts`) naming every registered job that declared
   * `concurrency` — refused rather than logged, because a documented guarantee that silently does
   * nothing is worse than either alternative.
   */
  readonly leases?: LeaseStore;
  readonly introspect?: JobIntrospection;
  close?(): Promise<void>;
}

export const DEFAULT_QUEUE = 'default';
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

let ambient: JobDriver | undefined;

/** Set once at boot from `app.config.ts`. Roles share one driver instance per process. */
export function setJobDriver(driver: JobDriver): void {
  ambient = driver;
}

export function jobDriver(): JobDriver | undefined {
  return ambient;
}

/**
 * Test/CLI seam: forget the ambient driver. The counterpart to `resetMailDriver()` — a test
 * that installs a queue has to be able to put the process back, or every later file in the
 * same bun process silently enqueues where it meant to run inline.
 */
export function resetJobDriver(): void {
  ambient = undefined;
}

/**
 * Every driver's `claim` opens with this, so the two cannot answer an empty list differently — and
 * they DID: `driver-memory.ts` read it as every queue and `driver-pg.ts` as the `default` one, with
 * this interface documenting neither. A semantic only one driver holds is a guarantee that passes
 * CI on memory and behaves differently on the deploy that runs Postgres, which is the whole reason
 * `driver-parity.test.ts` exists.
 *
 * Refused, never defaulted, for `X_RATE_LIMIT_BUCKET_CONFLICT`'s reason one package over: whichever
 * meaning a merge picked would leave the other a deployment somebody wrote against and nothing
 * enforces.
 */
export const assertClaimQueues = (driver: string, options: ClaimOptions): void => {
  if (options.queues.length === 0) throw new ClaimQueuesEmptyError(driver);
};

/**
 * The two NUMBERS of a claim, screened for both drivers in one place for the reason above: a value
 * neither of them refuses is answered two ways. `limit: -1` sliced every ready row but the newest
 * into a lease on the memory driver, where Postgres answers `LIMIT must not be negative`; `2.5`
 * claims 2 rows here and 3 there, with no error on either side.
 *
 * `limit` is a COUNT of rows and takes zero — claiming nothing is what a full worker asks for, and
 * both drivers already answer it identically. `visibilityTimeoutMs` is a DURATION, so it is
 * screened for finiteness alone, the same rule `worker-options.ts` applies to the same knob: it is
 * on this list because `visibleAt = at + NaN` is never `<= now`, which turns at-least-once into
 * never on a row `x jobs ls` still prints as `running`.
 */
export const assertClaimBounds = (driver: string, options: ClaimOptions): void => {
  finiteCount(`the ${driver} driver claim`, 'limit', options.limit);
  finiteOption(`the ${driver} driver claim`, 'visibilityTimeoutMs', options.visibilityTimeoutMs);
};
