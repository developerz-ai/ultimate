// The queue contract. Every driver implements exactly this, so a job's code never names one.
// Six methods and no more: claim/ack/nack with a visibility timeout is the smallest set that
// survives a worker crash.
//
// There is no config line that picks a backend: boot always builds `postgresJobDriver()`, and a
// stale `jobs.driver` in `app.config.ts` is refused by `defineConfig` (25.0.0; it was read by
// nothing since 5.0.0). `postgresJobDriver`, `redisJobDriver` and `memoryJobDriver` are the three
// that exist — 25.0.0 deleted the all-throw `redis` and `nats` stubs, and #710 built the Redis one
// for real. Swapping the driver is `jobs: other` in `apps/<app>/runtime.ts` and ZERO job-code
// change, and that is what the interface buys.

import { assert, finiteCount, finiteOption } from '@ultimat3/core';
import { adapterSlot } from '@ultimat3/core/adapter';
import type { BackfillLedger } from './backfill-ledger';
import type { AckOptions, NackOptions, SettleDebt } from './driver-settle';
import { ClaimQueuesEmptyError } from './errors';
import type { JobIntrospection, JobProgress } from './introspection';
import type { LeaseStore } from './leases';
import type { StepRecord, StepStore } from './steps';

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

/**
 * The states a row is still WORK in — queued, held or parked. One set, read by the idempotency
 * namespace (a key is taken only while a live row holds it) and by `cancel`, which stops live work
 * and refuses everything else: cancelling a dead letter rewrote the record of a failure into the
 * record of an operator's decision. The pg statements spell the same four.
 */
export const LIVE_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'ready',
  'delayed',
  'running',
  'suspended',
]);

/**
 * The states `stats()` counts, one bucket each (`ready` and `delayed` split by `runAt`): the live
 * four and the two an operator is paged on. `done` and `cancelled` rows count toward nothing, so
 * neither driver reads them — `SQL_STATS` and `x_jobs_depth_idx` spell the same six, and a queue
 * holding only finished rows is not listed.
 */
export const STATS_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'ready',
  'delayed',
  'running',
  'suspended',
  'failed',
  'dead',
]);

/**
 * What a row's `lastError` says when the CLAIM buried it: its lease lapsed on the attempt that was
 * its last, so nothing ever settled it and nothing may run it again. Fixed text, written by the
 * claim statement itself — no apostrophe, because it is spliced into SQL as a literal.
 */
/** A row's `lastError` when the claim settled it `failed` past its `expiresAt`. */
export const JOB_EXPIRED = 'expired';

export const LEASE_LAPSED_FINAL_ATTEMPT =
  'the lease lapsed on the final attempt: the worker holding this job stopped renewing it and never settled it, and no attempts remain';

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

/**
 * What an enqueue does when a LIVE row holds its key. `'replace'` is debounce: a `ready`/`delayed`
 * holder takes this request's `input` and `runAt`, in the same statement; a `running`/`suspended`
 * one is past replacing and the answer is `deduped`, as `'dedupe'` gives.
 */
export type ConflictPolicy = 'dedupe' | 'error' | 'replace';

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
  /**
   * Epoch ms past which this row is worthless: a claim that finds it `ready`/`delayed` after then
   * settles it `failed` with `lastError` `JOB_EXPIRED` instead of running it (reported through
   * `ClaimOptions.onExhausted`, as a burial is). A running or suspended run is never expired.
   */
  readonly expiresAt?: number;
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
   * refused** (`X_JOB_CLAIM_QUEUES_EMPTY`) — see `assertClaimQueues`. `jobWorker` passes exactly
   * one per pass, which is what keeps a slow queue from starving the others.
   */
  readonly queues: readonly string[];
  readonly limit: number;
  /** Lease length. A worker that dies without ack makes the job claimable again after this. */
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
  /**
   * Told the rows this pass BURIED instead of claiming: a lease that lapsed on the row's final
   * attempt is settled `dead` by the claim itself (`LEASE_LAPSED_FINAL_ATTEMPT`) and is never
   * handed out, so a job whose worker dies on every attempt reaches the dead-letter queue rather
   * than killing a worker per lease, forever. Called at most once per pass, after the statement
   * landed, with the rows as they now stand — what the claim round announces `onSettled` from
   * (`announceExhausted`). Omit it and the rows are buried all the same.
   */
  readonly onExhausted?: (dead: readonly JobRecord[]) => void;
  /**
   * Job NAMES whose final failure is `failed`, never `dead` — the ones declaring
   * `retry.deadLetter: false`. The row carries `max_attempts` and not the policy, so the caller
   * that holds the registry says which rows a burial DROPS; a name not listed is dead-lettered.
   */
  readonly dropExhausted?: readonly string[];
  /**
   * Told, when the pass claimed and buried NOTHING, how long until a row of these queues can next
   * become claimable — the earliest `runAt` of a waiting row and `visibleAt` of a held lease, over
   * the queues not paused — in ms from the driver's own clock (never an instant: the database's
   * `now()` is not this process's). `null` when nothing is waiting or held: only an enqueue can
   * make work, and that announces itself. At most once per pass, from the same statement; the
   * idle loop rests on it (`worker-loop.ts`). Omit it and nothing else changes.
   */
  readonly onEmpty?: (dueInMs: number | null) => void;
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
  /**
   * The run's step records as the claim read them, oldest first — so the attempt replays its
   * steps without one more round trip to list them (`stepRunner`'s `steps`). Every driver fills
   * it; a hand-built claim may omit it, and the runner then lists the store itself.
   */
  readonly steps?: readonly StepRecord[];
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

export type { AckOptions, NackOptions, SettleBy, SettleDebt, SettleDebtJob } from './driver-settle';
export { nackState } from './driver-settle';

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

/** What one queue's fleet must hold: `JobDriver.demand`. */
export interface QueueDemand {
  readonly queue: string;
  readonly demand: number;
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
  /**
   * `enqueue` for every request in ONE round trip — a statement on Postgres, a script on Redis —
   * answered in request order with what `enqueue` would have answered each: a repeat of an `id` or
   * a live key is `deduped: true`, a key twice in the batch is one job. REQUIRED, the one batch
   * path `handle.enqueueMany` and the outbox relay take. Opens with `assertEnqueueMany`.
   */
  enqueueMany(requests: readonly EnqueueRequest[]): Promise<readonly EnqueueResult[]>;
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
   * The jobs a live worker of this fleet must hold, per queue: running on a worker that still
   * serves, plus every due row of an unpaused queue. Only a queue with some is listed. What
   * `queue_demand` publishes and an autoscaler sizes by. Required since 30.0.0: `ready + running`
   * off `stats()` cannot tell a draining worker's runs from a serving one's, and the HPA sized on it.
   * A claimer no live registry row says drains is counted, so a driver with no registry counts all.
   */
  demand(): Promise<readonly QueueDemand[]>;
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
   * A driver without one can only hold the cap per process, so `jobWorker().start()` THROWS
   * `X_JOB_CONCURRENCY_UNENFORCEABLE` (`worker.ts`) naming every registered job that declared
   * `concurrency` — refused rather than logged, because a documented guarantee that silently does
   * nothing is worse than either alternative.
   */
  readonly leases?: LeaseStore;
  /**
   * Optional, like `leases`: the `onSettled` debt a settle records (`SettleBy.owesSettle`), what
   * makes the hook at-least-once across a crash. A driver without one runs it at most once.
   */
  readonly settleDebt?: SettleDebt;
  readonly introspect?: JobIntrospection;
  /**
   * How many rows wait (`ready` or `delayed`) on `queue`, counted no further than `cap`: what an
   * enqueue of a job declaring `maxPending` asks first (`enqueue-backlog.ts`). Optional for a
   * hand-rolled driver; such a job is then refused at enqueue rather than left uncapped.
   */
  backlog?(queue: string, cap: number): Promise<number>;
  /**
   * Whether a LIVE row holds `(name, tenant, key)` — the enqueue it answers inserts nothing. Asked
   * only by a `maxPending` enqueue the count already says is full, so a dedupe or a replace onto
   * its holder is not refused for a row it never adds. Optional: absent, such an enqueue is refused.
   */
  holds?(name: string, idempotencyKey: string, tenantId?: string): Promise<boolean>;
  /**
   * Tell every worker of the fleet that rows on `queue` (any, when none is named) may be claimable
   * before its rest ends. Present ONLY on a driver whose enqueues announce themselves (Postgres's
   * NOTIFY, the memory driver's in-process signal): an idle worker rests on a due time only over
   * such a driver (`worker-loop.ts`). Redis has no such channel and omits it.
   */
  wake?(queue?: string): Promise<void>;
  close?(): Promise<void>;
}

export const DEFAULT_QUEUE = 'default';
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

/** The installed queue: a stack, so boots and tests release in any order (`adapterSlot`). */
const slot = adapterSlot<JobDriver | undefined>(() => undefined);

/**
 * The boot's installer (its release removes THIS install only, in any order — `adapterSlot`), on `@ultimat3/jobs/adapter` and never the `.` barrel: an app swaps the queue
 * with `jobs:` in `apps/<app>/runtime.ts` (`RuntimeOverrides`), and a test with `@ultimat3/testing`.
 * One instance per process, never a config key.
 */
export function installJobDriver(driver: JobDriver): () => void {
  return slot.install(driver);
}

export function jobDriver(): JobDriver | undefined {
  return slot.current();
}

/**
 * Test/CLI seam: forget the ambient driver. The counterpart to `resetMailDriver()` — a test
 * that installs a queue has to be able to put the process back, or every later file in the
 * same bun process silently enqueues where it meant to run inline.
 */
export function resetJobDriver(): void {
  slot.reset();
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
 * Every driver's `enqueueMany` opens with this, so a batch is refused ONE way. `onConflict:
 * 'error'` has no batch meaning the drivers could share: Postgres inserts every other row of the
 * statement before the refusal is known, a loop only the rows before it — two different sets of
 * jobs left behind by one refused call. `'replace'` neither: one statement cannot update a row
 * twice (Postgres 21000). `expiresAt` is a single enqueue's too. `handle.enqueueMany` sets none.
 */
export const assertEnqueueMany = (driver: string, requests: readonly EnqueueRequest[]): void => {
  const at = requests.findIndex(
    (request) =>
      request.onConflict === 'error' ||
      request.onConflict === 'replace' ||
      request.expiresAt !== undefined,
  );
  assert(
    at === -1,
    `the ${driver} driver's enqueueMany was handed onConflict: 'error' or 'replace', or an expiresAt, on request ${at}, and a batch that refuses, replaces or expires would leave a different set of jobs behind on every driver`,
    'drop onConflict and expiresAt from the batch — a duplicate is answered deduped: true — or send that request alone: driver.enqueue({ ...request })',
  );
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
 * never on a row `x jobs list` still prints as `running`.
 */
export const assertClaimBounds = (driver: string, options: ClaimOptions): void => {
  finiteCount(`the ${driver} driver claim`, 'limit', options.limit);
  finiteOption(`the ${driver} driver claim`, 'visibilityTimeoutMs', options.visibilityTimeoutMs);
};

/**
 * ms from `at` until the first of `rows` can be claimed; `null` when none is waiting or held — a
 * claim's `onEmpty` answer over rows the caller already filtered to its open queues: the memory
 * driver's half of `SQL_CLAIM_IDLE`'s horizon arm.
 */
export function claimDueIn(rows: Iterable<JobRecord>, at: number): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.state === 'ready' || row.state === 'delayed' || row.state === 'suspended') {
      next = Math.min(next, row.runAt);
    } else if (row.state === 'running') {
      // `SQL_CLAIM`'s lapsed arm wants BOTH: the lease gone and the row due.
      next = Math.min(next, Math.max(row.visibleAt ?? at, row.runAt));
    }
  }
  return next === Number.POSITIVE_INFINITY ? null : next - at;
}
