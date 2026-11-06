// The `job` primitive's declared shapes: what a definition holds, what a run receives, and the
// handle `job()` returns. Types only, so the factory in `job.ts` stays one responsibility.

import type { Ctx } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { JobConcurrency, WhenBusy } from './concurrency';
import type { JobDescriptor } from './describe';
import type { EnqueueResult } from './driver';
import type { EnqueueManyOptions } from './job-enqueue-many';
import type { EnqueueOptions } from './outbox';
import type { ProgressFn } from './progress';
import type { RetryPolicy } from './retry';
import type { JobSettled } from './settled';
import type { StepApi } from './steps';
import type { JobTenant } from './tenant';

export interface JobRunArgs<I> {
  readonly input: I;
  readonly step: StepApi;
  /**
   * `ctx.signal` aborts when this attempt's `timeout` passes — the same seam an action reads, so
   * `throwIfAborted(ctx)` and `fetch(url, { signal: ctx.signal })` work here unchanged. Past it
   * the run belongs to whoever claims it next and `step.run` refuses to write, so a loop that
   * never checks it is a body running beside its own retry.
   */
  readonly ctx: Ctx;
  /** 1-based. Assume at-least-once: never branch on `attempt === 1` for correctness. */
  readonly attempt: number;
  /**
   * True when a failure of THIS attempt is not retried for want of attempts — the same boolean
   * the runner dead-letters on (`isFinalAttempt` in `retry.ts`), so a body never re-derives it
   * from `retry.attempts`. The place to release what a retry would have reused. REQUIRED: a test
   * that drives a body by hand states it, `isFinalAttempt(handle.retry, attempt)` being the
   * runner's own answer.
   *
   * Not "this body runs once more at most": a `terminal` error stops an earlier attempt, and an
   * attempt handed back UNCOUNTED — a `step.sleep`, a drain — is presented again under the same
   * number, so the last attempt of a job that sleeps sees `true` on every resume.
   */
  readonly finalAttempt: boolean;
  /**
   * `progress(done, total, note?)` — how far this run has got, shown by `x jobs show` and the
   * dashboard. Call it as often as the loop turns: it is written to the row at most once a
   * second, and the last call before the run settles is always written.
   */
  readonly progress: ProgressFn;
  readonly jobId: string;
  readonly runId: string;
}

export interface JobDefinition<I, R = unknown> {
  /**
   * Omit it: `defineApi({ jobs })` assigns the export name. Set it only to pin a queue key the
   * export name must not decide — a framework job like `mail.send`, or a name rows already carry.
   */
  readonly name?: string;
  readonly input: StandardSchemaV1<unknown, I>;
  /** REQUIRED. See the file header — this is the whole point. */
  readonly idempotencyKey: (input: I) => string;
  /**
   * REQUIRED, and the org this job's body runs under. `tenant: (input) => input.orgId` derives it
   * from the payload; `tenant: 'none'` says this job belongs to no tenant, and then every
   * tenant-scoped read inside it fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED`.
   *
   * There is no default, because both candidates are wrong. Until this field existed the worker ran
   * a body with no ambient context at all, so `@ultimat3/entity`'s tenant guard — which derives
   * from `tryUseContext()` and not from the ctx it is handed — read no actor, added no predicate
   * and accepted a caller-named `orgId` unchecked: the same write refused over HTTP as
   * `X_TENANCY_ACTOR_MISMATCH` was ACCEPTED through the job surface. A boot-supplied service actor
   * would close that with ONE identity for every job, which is a cross-tenant read waiting for the
   * first job that takes an org id in its input. So the job declares it, per job, from its own
   * payload — the value an author already had to pass anyway.
   */
  readonly tenant: JobTenant<I>;
  readonly retry: RetryPolicy;
  readonly queue?: string;
  /**
   * Max in-flight runs of THIS job across the fleet. Omit for the queue-wide cap.
   *
   * A number is one cap for the job. `{ key, limit, whenBusy }` is that cap PER KEY — "one run
   * per account" — and says what a claim over it does: `'wait'` (default) leaves the run queued,
   * `'fail'` settles it `failed` with `X_JOB_KEY_BUSY` without running its body (`concurrency.ts`).
   *
   * Enforced by `JobDriver.leases` — a row every replica can see — and NOT by `limits.ts`, which
   * counts one process's heap. A driver with no lease store cannot hold this cap, so
   * `jobWorker().start()` refuses to boot rather than let it pass silently
   * (`X_JOB_CONCURRENCY_UNENFORCEABLE`): this field was declared, documented and in the manifest
   * while nothing read it, which is exactly what axiom 3 exists to prevent.
   */
  readonly concurrency?: JobConcurrency<I>;
  readonly timeout?: DurationInput;
  /**
   * Ceiling for ONE `step.run`, where `timeout` is the ceiling for the whole attempt. Folded into
   * the signal the step body is handed, so a body reads one signal and sees whichever deadline
   * lands first — and it ABORTS before it rejects, because the attempt that replaces this one is
   * claimable the moment the nack lands.
   *
   * Declared here and nowhere else: the runner has implemented this ceiling since 1.0 and no
   * declaration could ask for it, which is a documented guarantee that does nothing.
   */
  readonly stepTimeout?: DurationInput;
  /**
   * Ceiling for `onSettled`, every try included. Default `ON_SETTLED_TIMEOUT_MS`. It aborts the
   * hook's `ctx.signal` with `X_JOB_TIMEOUT`, then the worker moves on, so a hook on a dead host
   * cannot hold a slot for good.
   */
  readonly onSettledTimeout?: DurationInput;
  /**
   * How long a `step.waitForEvent` parks between polls. Default 30s — 15 min when the event bus
   * wakes its waiters (`postgresEventBus` over the queue's database, as boot installs it), where
   * the poll is only the backstop. Lower it for a wait a user is watching on a bus that does not
   * wake; the step suspends for exactly this long each time, never a busy loop.
   */
  readonly eventPoll?: DurationInput;
  /**
   * This job undoes its steps when it fails FOR GOOD: `step.run(name, fn, { compensate })` is
   * legal, and the row is enqueued with `UNWIND_MARGIN` attempts past `retry.attempts`, so a
   * crash on the final attempt still unwinds. Default false: no path of the job changes.
   */
  readonly compensates?: boolean;
  run(args: JobRunArgs<I>): Promise<R>;
  /**
   * How the run ENDED, once: `completed` with what `run` returned, `dead-lettered`, `dropped`
   * (`retry.deadLetter: false`) or `refused` (`whenBusy: 'fail'` over a busy key — the body never
   * ran). Called after the row is settled, by the worker whose settle landed, under the job's
   * tenant. Not called for a retry, a suspension, a drain, or a row an operator cancelled.
   *
   * AT MOST ONCE across a crash: a worker killed between the settle and this call never makes it.
   * In one process it gets `ON_SETTLED_ATTEMPTS` tries; if all throw, the failure is logged and
   * reported (`X_JOB_ON_SETTLED_FAILED`) and the row is untouched. What must be recorded for
   * certain belongs in the body, inside a `step.run`.
   */
  onSettled?(settled: JobSettled<I, R>): Promise<void>;
}

/**
 * Whoever the enqueue is for. Structural, exactly like `tenantKeyFrom` in `limits.ts`: the
 * queue needs the actor's org and nothing else, so this package never imports the auth types.
 */
export interface JobActor {
  readonly orgId?: string | undefined;
  /**
   * The actor's id, recorded as `enqueuedBy` — ATTRIBUTION, never authority.
   *
   * The framework picks one answer to "whose permissions does a job run with" (axiom 1) and it is
   * this: a job body runs with SYSTEM authority and this is an audit column. Impersonating the
   * enqueuer at claim time is the defensible alternative and is rejected for one reason — a job
   * that sleeps three days, or dead-letters and is retried next quarter, would then act as
   * somebody whose role, org membership or employment has changed since. `02-primitives.md`
   * already frames a job as server-authoritative work. A job that must act FOR a user takes that
   * user's id in its input and re-authorises it in the body, where the check is visible in review.
   */
  readonly id?: string | undefined;
}

/**
 * Methods (not function-typed properties) throughout, so `JobHandle<Specific>` is assignable
 * to `AnyJobHandle` and heterogeneous handles can share a registry and a task's enqueue list.
 */
export interface JobHandle<I = unknown> {
  readonly kind: 'job';
  readonly name: string;
  readonly queue: string;
  readonly retry: RetryPolicy;
  /** The declared cap, resolved: the plain number, or a keyed declaration's `limit`. */
  readonly concurrency: number | undefined;
  /**
   * What a claim over the cap does — set exactly when the cap is KEYED, `undefined` for a plain
   * number and for no cap. A resolved field and never the declaration itself: `key` is a function
   * of `I`, and a function-typed property would break `AnyJobHandle` — see `tenantFor`.
   */
  readonly whenBusy: WhenBusy | undefined;
  readonly timeoutMs: number | undefined;
  /** The declared per-step ceiling in ms; `executeJob` hands it to the step runner. */
  readonly stepTimeoutMs: number | undefined;
  readonly onSettledTimeoutMs: number;
  /** The declared event-poll interval in ms; `undefined` leaves the runner's default. */
  readonly eventPollMs: number | undefined;
  /** `compensates: true` was declared. `executeJob` unwinds a run that failed for good. */
  readonly compensates: boolean;
  readonly input: StandardSchemaV1<unknown, I>;
  parse(raw: unknown): I;
  idempotencyKeyFor(input: I): string;
  /**
   * The org THIS payload's run acts under — `undefined` for `tenant: 'none'`. A method and never a
   * `readonly tenant: JobTenant<I>` field: a function-typed property is contravariant in its
   * parameter, so `JobHandle<OrgInput>` would stop being assignable to `AnyJobHandle` and the
   * registry, the worker and a task's enqueue list could no longer hold heterogeneous handles.
   */
  tenantFor(input: I): string | undefined;
  /**
   * The concurrency key THIS payload's run counts under — `undefined` when the cap is not keyed.
   * Refuses an empty key (`X_JOB_DECLARATION_INVALID`): the facade asks it at enqueue so the
   * refusal reaches the caller, and the worker asks it again at claim.
   */
  concurrencyKeyFor(input: I): string | undefined;
  run(args: JobRunArgs<I>): Promise<unknown>;
  /** Whether the definition declared `onSettled` — published by `describe()`. */
  readonly declaresOnSettled: boolean;
  /**
   * The declared hook; a no-op when there is none. A method, for `tenantFor`'s variance reason,
   * and `unknown`-typed on both sides for the same one: the handle carries no result generic, so
   * the definition's own `onSettled` is where `result` and `input` are typed.
   */
  onSettled(settled: JobSettled<unknown>): Promise<void>;
  /**
   * Put this job on the queue. Joins the caller's transaction when the app installed the
   * outbox — same call site in a request handler, a job, a script or a test.
   */
  enqueue(input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Many inputs of this job, one round trip per 1,000, answered in input order — never a loop of
   * `enqueue` (`X_N_PLUS_ONE_WRITE`). At most `MAX_ENQUEUE_BATCH`; see `job-enqueue-many.ts`.
   */
  enqueueMany(
    inputs: readonly I[],
    options?: EnqueueManyOptions,
  ): Promise<readonly EnqueueResult[]>;
  /**
   * Enqueue on behalf of `actor`: fills `tenantId` from the actor's org so per-tenant limits
   * apply. It queues rather than running inline because a job's execution surface IS the
   * queue — an inline run would be a second execution path alongside `executeJob`.
   */
  as(actor: JobActor | null, input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
  describe(): JobDescriptor;
}

export type AnyJobHandle = JobHandle<unknown>;
