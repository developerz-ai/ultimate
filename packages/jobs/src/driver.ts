// The queue contract. Every driver implements exactly this, so a job's code never names one.
// Six methods and no more: claim/ack/nack with a visibility timeout is the smallest set that
// survives a worker crash.
//
// This header used to say "switching backends is a config line" (`As of 2026-08`). There is no
// such config line: `JobsConfig.driver` has no reader anywhere and boot always builds
// `createPgDriver`. `pg` and `memory` are the two that exist; `redis` and `nats` are honest
// `X_NOT_IMPLEMENTED` stubs. What IS true is the second half — swapping the driver is
// `setJobDriver(other)` and ZERO job-code change — and that is what the interface buys.

import type { BackfillLedger } from './backfill-ledger';
import type { LeaseStore } from './leases';
import type { StepStore } from './steps';

/**
 * `cancelled` is terminal and is NOT `dead`: a dead letter is work that failed and can be retried,
 * a cancellation is work an operator stopped on purpose and `x jobs retry` must not resurrect by
 * accident. It appears in no claim predicate, so the queue never hands a cancelled row out again.
 */
export type JobState =
  | 'ready'
  | 'delayed'
  | 'running'
  | 'suspended'
  | 'done'
  | 'failed'
  | 'dead'
  | 'cancelled';

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
  readonly claimedBy?: string;
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
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  /** Epoch ms. Omit for "now". */
  readonly runAt?: number;
  readonly tenantId?: string;
  /** Reuse an existing run id when resuming, so step history is preserved. */
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
  readonly queues: readonly string[];
  readonly limit: number;
  /** Lease length. A worker that dies without ack makes the job claimable again after this. */
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
}

export interface ClaimedJob extends JobRecord {
  readonly claimedAt: number;
  readonly visibleAt: number;
}

export interface NackOptions {
  /** Delay before the job becomes claimable again. */
  readonly delayMs: number;
  readonly error?: string;
  /**
   * False for a suspension (`step.sleep`): parking a run is not a failure and must not burn
   * a retry attempt, or a 3-day sleep would dead-letter the job.
   */
  readonly countsAsAttempt?: boolean;
  readonly deadLetter?: boolean;
}

export interface QueueStats {
  readonly queue: string;
  readonly ready: number;
  readonly delayed: number;
  readonly running: number;
  readonly suspended: number;
  readonly dead: number;
  /** Age in ms of the oldest claimable job — the number that decides autoscaling. */
  readonly oldestReadyMs: number;
}

export interface JobFilter {
  readonly queue?: string;
  readonly name?: string;
  readonly state?: JobState;
  readonly limit?: number;
}

/** Optional: powers `/_x` and the MCP tools. A minimal driver may omit it. */
export interface JobIntrospection {
  job(jobId: string): Promise<JobRecord | undefined>;
  list(filter?: JobFilter): Promise<readonly JobRecord[]>;
  deadLetters(limit?: number): Promise<readonly JobRecord[]>;
  /** Re-queue a dead/failed job. `fromStep` drops step records from that step onward. */
  requeue(jobId: string, options?: { readonly fromStep?: string }): Promise<JobRecord>;
  /**
   * Stop a job from outside. The only answer to a runaway pass that was otherwise "scale the
   * worker to zero" (which stops every job) or a hand-written `UPDATE` (which the running
   * worker's next ack overwrote). Terminal for a queued row immediately; a RUNNING one stops at
   * its next heartbeat, which no longer matches its own row and cancels the attempt.
   *
   * Optional on the interface for the reason `requeue` is not: a driver may have no way to
   * address a single row. Answers `undefined` for a job id it does not hold.
   */
  cancel?(jobId: string, reason?: string): Promise<JobRecord | undefined>;
}

export interface HeartbeatOptions {
  readonly visibilityTimeoutMs: number;
  /** Renew only if this worker is still the claimant. Omit and any claimant matches. */
  readonly workerId?: string;
}

export interface JobDriver {
  readonly name: string;
  /** Step persistence lives with the queue: one store, one transaction boundary. */
  readonly steps: StepStore;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;
  ack(jobId: string): Promise<void>;
  nack(jobId: string, options: NackOptions): Promise<void>;
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
   * A driver without one enforces `concurrency` per process and the worker says so at start
   * (`jobs.worker.concurrency-unenforced`) rather than letting the guarantee pass silently.
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
