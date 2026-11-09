// The error classes @ultimat3/jobs throws. Every one names the command or code change that fixes
// it — a job failure an agent cannot act on is a job failure that gets retried forever. The codes,
// their titles and their registration are `./error-codes`, imported here for that side effect.
import { UltimateError } from '@ultimat3/core';
import './error-codes';

// No `docs:` on any class below, here or in `backfill-errors.ts`. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every
// code, never one per code, because `wiki/` is the framework's only public documentation surface
// and a code lives there in a TABLE ROW, which has no anchor. The `docsFor` that stood here built
// `https://ultimate.dev/errors/<code>`, which answered 404, host included, on every job failure
// this package has ever put in a dead-letter row.

/** An enqueue collided with a live job holding the same idempotency key under `onConflict: 'error'`. */
export class JobDuplicateError extends UltimateError {
  /** `fix` for a caller the enqueue-time instruction does not fit — a requeue, where it is moot. */
  constructor(input: { job: string; idempotencyKey: string; existingId: string; fix?: string }) {
    super({
      code: 'X_JOB_DUPLICATE',
      cause: `job "${input.job}" already queued as ${input.existingId} with idempotencyKey "${input.idempotencyKey}"`,
      fix: input.fix ?? 'pass onConflict: "dedupe" to enqueue, or make idempotencyKey narrower',
    });
  }
}

/**
 * Two things claim one durable name — two definitions setting the same `name:`, two handles under
 * one export name, or one handle exported twice. Shares `X_JOB_DUPLICATE` with the enqueue-time
 * collision because it is the same statement — this key already belongs to another job — caught
 * one stage earlier. Left unrefused, the second claim would silently take over delivery of every
 * row already queued under the first.
 *
 * The `fix` names the edit and the command that shows what is already seated. It cannot name a
 * file: the registry holds handles, not source locations, and `name` is all a handle carries.
 */
export class JobNameTakenError extends UltimateError {
  constructor(input: { kind: 'job' | 'task'; name: string }) {
    super({
      code: 'X_JOB_DUPLICATE',
      cause: `two ${input.kind}s claim the name "${input.name}"`,
      fix: `x jobs list --json names the one already seated; rename the other's export, or its "name:" if it declares one — a ${input.kind} name is a durable queue key and is globally unique`,
    });
  }
}

/**
 * A `text` status column holds a value outside the vocabulary this build compiled.
 *
 * Refused rather than passed through, because the alternative is what used to happen: the three
 * decoders in `driver-pg-rows.ts` cast the column, and `stepRun`'s `existing?.status ===
 * 'completed'` then read false for the laundered value and RE-EXECUTED the step. A second charge
 * is a worse answer than a failed attempt, and "an unrecognised fact is never a satisfied one" is
 * the rule the rest of the framework already follows.
 *
 * Almost always a NEWER deploy's row, not corruption: a status string only reaches the table
 * because some version of this framework wrote it. A rolling deploy that only ADDS a status is
 * safe in the normal direction — the new build knows every old value — and it is the old build
 * reading the new build's row that lands here, on that one job, loudly.
 */
export class JobRowStatusUnknownError extends UltimateError {
  constructor(input: { table: string; column: string; value: string; known: readonly string[] }) {
    super({
      code: 'X_JOB_ROW_STATUS_UNKNOWN',
      cause:
        `${input.table}.${input.column} holds "${input.value}", which this build does not know — ` +
        `it reads ${input.known.join(', ')}`,
      fix: `x jobs show --json   # then drain the older workers: a status this build cannot read was almost certainly written by a newer deploy`,
    });
  }
}

/**
 * `registerJobs()` was handed `someAction.job()`.
 *
 * That call answers an `ActionJobHandle` — `kind: 'action-job'`, deliberately a different literal
 * from `'job'` — which is the four fields `job()` takes, not a job. It cannot be one: `action` and
 * `jobs` are both tier 3, so neither may import the other, and only `job()` seats a handle the
 * queue, the worker and the manifest accept.
 *
 * Refused BY NAME rather than skipped, which is what used to happen. `registerJobs(module)` is
 * handed a whole module namespace, so silently ignoring a constant or a helper exported beside a
 * job is right — but ignoring this one meant `registerJobs({ publishPost: publishPost.job() })`
 * registered nothing, returned `[]`, and the job never ran, with nothing failing anywhere.
 */
export class ActionJobUnbridgedError extends UltimateError {
  constructor(input: { export: string; job: string }) {
    super({
      code: 'X_ACTION_JOB_UNBRIDGED',
      cause: `export "${input.export}" is the action projection "${input.job}", which is not a job handle and cannot be registered as one`,
      fix: `wrap it: agentJob(${input.export}, { name: '${input.export}', tenant, retry }) from @ultimat3/ai — that composes job() and returns a handle the queue accepts`,
    });
  }
}

/** Two steps in one run share a name, so replay cannot tell their persisted results apart. */
export class StepDuplicateError extends UltimateError {
  constructor(input: { job: string; step: string }) {
    super({
      code: 'X_STEP_DUPLICATE',
      cause: `job "${input.job}" used step name "${input.step}" twice in one run`,
      fix: `rename one of them, e.g. step.run('${input.step}-2', ...) — step names are the replay key`,
    });
  }
}

export class JobTimeoutError extends UltimateError {
  /** `fix` for a ceiling the job's `timeout` does not set: the `onSettled` hook's. */
  constructor(input: { job: string; timeoutMs: number; step?: string; fix?: string }) {
    super({
      code: 'X_JOB_TIMEOUT',
      cause:
        input.step === undefined
          ? `job "${input.job}" exceeded its ${input.timeoutMs}ms timeout`
          : `job "${input.job}" step "${input.step}" exceeded its ${input.timeoutMs}ms timeout`,
      fix:
        input.fix ?? `raise timeout on the job definition, or split the work into step.run() calls`,
    });
  }
}

/**
 * This attempt was cancelled — its deadline passed, or the caller went away — and something in it
 * tried to keep going. The run belongs to whoever claims it next, so a step write from here would
 * land on their history.
 *
 * Core's `X_ABORTED` rather than a code of jobs' own: the framework already means exactly one
 * thing by "the signal fired, stop work", and a second name for it would make an agent ask which
 * one it is looking at. `X_JOB_TIMEOUT` stays the code the ATTEMPT fails with; this is the code
 * the work inside it stops with.
 */
export class JobAbortedError extends UltimateError {
  /** `ended`: the attempt FINISHED — it was not cancelled — and a step it never awaited came late. */
  constructor(input: { job: string; step?: string; ended?: boolean }) {
    super({
      code: 'X_ABORTED',
      cause:
        input.step === undefined
          ? `job "${input.job}" was cancelled — this attempt no longer owns the run`
          : input.ended === true
            ? `job "${input.job}"'s attempt had already ended when step "${input.step}" finished — run() returned without awaiting it`
            : `job "${input.job}" was cancelled before step "${input.step}" could be recorded`,
      fix:
        input.ended === true
          ? `await step.run('${input.step ?? '<name>'}', fn) inside run(); work meant to outlive the attempt (a flush, a deferred enqueue): runToCompletion(() => work) from @ultimat3/core`
          : 'add throwIfAborted(ctx) before expensive work, or pass fetch(url, { signal: ctx.signal }) — the queue re-runs the job, so stop at the deadline instead of running past it; work meant to outlive the attempt: runToCompletion(() => work) from @ultimat3/core',
    });
  }
}

/**
 * The worker holding this attempt received SIGTERM. Handed to the run as `ctx.signal`'s reason
 * the moment the drain's `accept` phase runs — before core's in-flight wait, not at the deadline
 * that ends it — so a body reading the one cancellation seam learns the process is going away
 * while there is still budget to unwind in.
 *
 * Core's `X_DRAINING` rather than a code of jobs' own, for `JobAbortedError`'s reason: the
 * framework already means exactly one thing by "the process is draining", it is already
 * classified `retryable`, and `executeJob` reads the CODE off the run signal's reason to tell a
 * drained attempt from a timed-out or lease-lost one — the drained one is handed back uncounted.
 */
export class JobDrainedError extends UltimateError {
  constructor(input: { workerId: string; signal: string }) {
    super({
      code: 'X_DRAINING',
      cause: `worker "${input.workerId}" is draining (${input.signal}) — this attempt is cut short and the job handed back to the queue with the attempt uncounted`,
      fix: 'nothing on the job: another worker claims it. To unwind inside the drain budget instead of being killed at it, pass ctx.signal to every outbound call — fetch(url, { signal: ctx.signal }) — and call throwIfAborted(ctx) between steps',
    });
  }
}

/** Retries exhausted. The job is in the dead-letter queue, not lost. */
export class JobMaxAttemptsError extends UltimateError {
  constructor(input: { job: string; jobId: string; attempts: number; lastError: string }) {
    super({
      code: 'X_JOB_MAX_ATTEMPTS',
      cause: `job "${input.job}" failed ${input.attempts} times, last error: ${input.lastError}`,
      fix: `x jobs retry ${input.jobId}`,
    });
  }
}

export class DriverUnavailableError extends UltimateError {
  constructor(input: { driver: string; cause: string; fix: string }) {
    super({
      code: 'X_DRIVER_UNAVAILABLE',
      cause: `jobs driver "${input.driver}" is unavailable: ${input.cause}`,
      fix: input.fix,
    });
  }
}

/**
 * The type signature already requires `idempotencyKey`; this is the runtime backstop for
 * generated code and JS callers, so the guarantee holds at both ends.
 */
export class IdempotencyRequiredError extends UltimateError {
  /**
   * `positional` is a name `job()` minted from a counter (`anonymous-job-3`). Spliced into the key
   * template it would be written into persisted idempotency keys — and it MOVES when an import is
   * added above the declaration, so every key written before the move stops matching. The fix
   * names the edit instead of the counter.
   */
  constructor(input: { job: string; positional?: boolean }) {
    super({
      code: 'X_IDEMPOTENCY_REQUIRED',
      cause: `job "${input.job}" has no idempotencyKey — at-least-once delivery would run it twice`,
      fix:
        input.positional === true
          ? `give the job a stable name first — job({ name: 'syncInvoices', … }), or register it in apps/web/api/index.ts so its export name is stamped — then add idempotencyKey: (input) => \`syncInvoices:\${input.id}\``
          : `add idempotencyKey: (input) => \`${input.job}:\${input.id}\` to the job definition`,
    });
  }
}

/**
 * A job declared no `tenant`. The type already requires it; this is the runtime backstop for
 * generated code and JS callers, so the guarantee holds at both ends — the shape
 * `IdempotencyRequiredError` above already has.
 *
 * It is refused rather than defaulted because both defaults are wrong. `'none'` silently reopens
 * the hole this field closes: the body would run with no org, and before this field existed that
 * meant `@ultimat3/entity`'s guard read no actor at all and accepted a caller-named tenant
 * unchecked. Inheriting the worker's org would make one identity serve every job, which is the
 * cross-tenant read the declaration exists to prevent.
 */
export class JobTenantRequiredError extends UltimateError {
  constructor(input: { job: string }) {
    super({
      code: 'X_JOB_TENANT_REQUIRED',
      cause: `job "${input.job}" declares no tenant — a job body runs with no request behind it, so every tenant-scoped read inside it would be unscoped`,
      // `'none'` reads differently either side of `backfill()` and the fix has to say so: for a
      // plain job it means "touches no tenant-scoped table", because the org is STRIPPED and any
      // scoped read fails closed — but a backfill declaring it is how a sweep says it spans every
      // tenant, and the pass opens the cross-tenant scope for exactly that declaration. Half the
      // callers of this code arrive through `backfill()`, which forwards its `tenant` to `job()`.
      fix: `add tenant: (input) => input.orgId to job("${input.job}") — or tenant: 'none', which declares NO org: right for a job that touches no tenant-scoped table, and the spelling a backfill() uses to sweep every tenant`,
    });
  }
}

/**
 * The queue took this job back while it was still running: `x jobs cancel` wrote a terminal state,
 * or this worker's lease lapsed and another one re-claimed the row. Its own code and not
 * `X_ABORTED`, because the response is different — `X_ABORTED` is "your deadline passed, make the
 * work smaller", this is "somebody else owns this run now, stop writing to it".
 */
export class LeaseLostError extends UltimateError {
  constructor(input: { job: string; jobId: string }) {
    super({
      code: 'X_JOB_LEASE_LOST',
      cause: `job "${input.job}" (${input.jobId}) is no longer claimed by this worker — it was cancelled, or its visibility lease lapsed and the queue re-delivered it`,
      fix: `x jobs show ${input.jobId} --json`,
    });
  }
}

/**
 * The fleet slot this run holds under `job.concurrency` is somebody else's now: renewal answered
 * "not yours", which is the one thing `LeaseStore.renew` can say that a retry cannot fix. Its own
 * code and not `X_JOB_LEASE_LOST`, because they are different rows on different clocks — the
 * queue may still consider this worker the owner of the JOB while another worker is already
 * running one under the same cap, which is precisely the guarantee `concurrency` sells.
 */
export class JobSlotLostError extends UltimateError {
  constructor(input: { job: string; jobId: string; slot: number }) {
    super({
      code: 'X_JOB_SLOT_LOST',
      cause: `job "${input.job}" (${input.jobId}) no longer holds fleet concurrency slot ${input.slot} — its lease expired and another worker took it`,
      fix: `x jobs show ${input.jobId} --json`,
    });
  }
}

/**
 * `x jobs cancel` reached a job that already finished. Not a failure of the command — the work is
 * done — but never a silent success either: an operator cancelling a runaway pass has to know
 * whether they stopped it or missed it.
 */
export class JobNotCancellableError extends UltimateError {
  constructor(input: { jobId: string; state: string }) {
    super({
      code: 'X_JOB_NOT_CANCELLABLE',
      cause:
        input.state === 'missing'
          ? `no job ${input.jobId} exists in this queue`
          : `job ${input.jobId} is "${input.state}" and only a job that has not finished can be cancelled`,
      fix: `x jobs list --state running --json`,
    });
  }
}

/** The driver has no `introspect.cancel` — a hand-rolled driver that ships no introspection. */
export class CancelUnsupportedError extends UltimateError {
  constructor(input: { driver: string }) {
    super({
      code: 'X_JOB_NOT_CANCELLABLE',
      cause: `the "${input.driver}" jobs driver cannot cancel a single job`,
      fix: 'postgresJobDriver({ executor })   # jobs: in apps/<app>/runtime.ts, or drop that field and the boot builds it over DATABASE_URL — only the pg driver implements introspect.cancel — then: x jobs cancel <id> --json',
    });
  }
}

/**
 * `enqueueMany` handed more inputs than one call takes. Refused before any key is derived or any
 * row is written, so nothing of the batch lands: a list that size is a table, and a table is a
 * `backfill()` that pages it, not one call holding every row in memory.
 */
export class JobEnqueueBatchTooLargeError extends UltimateError {
  constructor(input: { job: string; count: number; max: number }) {
    super({
      code: 'X_JOB_ENQUEUE_BATCH_TOO_LARGE',
      cause: `${input.job}.enqueueMany was handed ${input.count} inputs, past the ${input.max} one call may stage`,
      fix: `await handle.enqueueMany(inputs.slice(i, i + ${input.max})) for i = 0, ${input.max}, … with handle = ${input.job} — or page the source with backfill() from @ultimat3/jobs`,
      meta: { job: input.job, count: input.count, max: input.max },
    });
  }
}

/** An outbox enqueue happened with no ambient transaction to join. */
export class OutboxNoTxError extends UltimateError {
  constructor(input: { job: string }) {
    super({
      code: 'X_OUTBOX_NO_TX',
      cause: `ctx.jobs.enqueue(${input.job}) ran outside a transaction with outbox: 'required'`,
      fix: 'wrap the call in ctx.tx(async (tx) => ...), or enqueue with { outbox: false }',
    });
  }
}

/**
 * `claim({ queues: [] })`, refused by every driver rather than answered by each.
 *
 * The two shipped drivers had two meanings for it — every queue on `driver-memory.ts`, the
 * `default` queue on `driver-pg.ts` — and `ClaimOptions.queues` documented neither. Nothing reached
 * it (`jobWorker` passes exactly one queue per pass), so the divergence could only ever be found
 * by an embedder in production, and each meaning is silently wrong in the other's deployment: one
 * takes work this worker was never configured for, the other drains nothing and reads as an idle
 * queue. There is no third meaning to pick — an empty list is a caller that has not said what to
 * claim.
 */
export class ClaimQueuesEmptyError extends UltimateError {
  constructor(driver: string) {
    super({
      code: 'X_JOB_CLAIM_QUEUES_EMPTY',
      cause: `the ${driver} driver was asked to claim with queues: [] — an empty list names no queue, and "every queue" and "the default queue" are different deployments`,
      fix: "pass the queue by name — driver.claim({ queues: ['default'], limit, visibilityTimeoutMs, workerId }) — or read the list from config.jobs.queues, which is what jobWorker walks one queue at a time",
      meta: { driver },
    });
  }
}
