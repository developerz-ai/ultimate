// The X_* codes owned by @ultimat3/jobs. Every one names the command or code change that
// fixes it — a job failure an agent cannot act on is a job failure that gets retried forever.
import { registerErrorCodes, registerErrorRetry, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const JOB_OWNED_ERROR_CODES = [
  'X_JOB_DUPLICATE',
  'X_STEP_DUPLICATE',
  'X_JOB_TIMEOUT',
  'X_JOB_MAX_ATTEMPTS',
  'X_DRIVER_UNAVAILABLE',
  'X_IDEMPOTENCY_REQUIRED',
  'X_JOB_TENANT_REQUIRED',
  'X_JOB_CONCURRENCY_UNENFORCEABLE',
  'X_JOB_LEASE_LOST',
  'X_JOB_SLOT_LOST',
  'X_JOB_NOT_CANCELLABLE',
  'X_OUTBOX_NO_TX',
  'X_BACKFILL_PENDING',
  'X_BACKFILL_APPLIED',
  'X_BACKFILL_ENVIRONMENT',
  'X_BACKFILL_MIGRATION_PENDING',
  'X_BACKFILL_RUNNING',
  'X_BACKFILL_STALLED',
  'X_BACKFILL_UNKNOWN',
  'X_JOB_ROW_STATUS_UNKNOWN',
  'X_ACTION_JOB_UNBRIDGED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` and `X_ABORTED` are `@ultimat3/core`'s. `JobsNotImplementedError` and
 * `JobAbortedError` below throw them; jobs keeps no title for either, because the copy this file
 * used to hold was a second title that nothing would have failed on once core's changed.
 */
export const JOB_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_ABORTED'] as const;

/** Every code jobs can throw: the ones it owns plus the one it borrows. */
export const JOB_ERROR_CODES = [...JOB_OWNED_ERROR_CODES, ...JOB_BORROWED_ERROR_CODES] as const;

export type JobOwnedErrorCode = (typeof JOB_OWNED_ERROR_CODES)[number];
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export const JOB_ERROR_TITLES: Readonly<Record<JobOwnedErrorCode, string>> = {
  X_JOB_DUPLICATE: 'a live key already has a job',
  X_STEP_DUPLICATE: 'two step.run calls share a name',
  X_JOB_TIMEOUT: 'a job exceeded its wall-clock limit',
  X_JOB_MAX_ATTEMPTS: 'the job exhausted its retries',
  X_DRIVER_UNAVAILABLE: 'the queue driver is unreachable',
  X_IDEMPOTENCY_REQUIRED: 'the job has no idempotencyKey',
  X_JOB_TENANT_REQUIRED: 'the job declares no tenant',
  X_JOB_CONCURRENCY_UNENFORCEABLE: 'job.concurrency is declared and cannot be enforced',
  X_JOB_LEASE_LOST: 'the queue took this job back mid-run',
  X_JOB_SLOT_LOST: 'the fleet concurrency slot was taken by another worker',
  X_JOB_NOT_CANCELLABLE: 'the job cannot be cancelled',
  X_OUTBOX_NO_TX: 'enqueue outside a transaction',
  X_BACKFILL_PENDING: 'a declared backfill has never completed',
  X_BACKFILL_APPLIED: 'the ledger already holds a completed pass',
  X_BACKFILL_ENVIRONMENT: 'the backfill is not declared for this environment',
  X_BACKFILL_MIGRATION_PENDING: 'the migration this backfill requires is not applied',
  X_BACKFILL_RUNNING: 'a pass under this name is already live',
  X_BACKFILL_STALLED: 'the sweep ended with rows its own count still matches',
  X_BACKFILL_UNKNOWN: 'no declaration carries this backfill name',
  X_JOB_ROW_STATUS_UNKNOWN: 'a queue row carries a status this build does not know',
  X_ACTION_JOB_UNBRIDGED: 'an action projection was registered as a job',
};

// One unconditional call, so a second package claiming one of jobs' codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(JOB_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The codes of this package's that can be thrown INSIDE a job body, classified — `executeJob`
 * reads this, so a `terminal` one dead-letters on the attempt it happened instead of spending the
 * whole policy on an answer that cannot change. Same rule every package uses: retryable means the
 * same code, run again, has a real chance of a different answer.
 *
 * Two are deliberately absent. `X_JOB_LEASE_LOST` and `X_JOB_SLOT_LOST` mean the row is somebody
 * else's now, so this attempt's verdict is not this attempt's to give: dead-lettering would settle
 * a job another worker is running. They keep the attempt-count path, which ends in the queue
 * re-delivering — the honest outcome for "we stopped owning it".
 */
registerErrorRetry({
  X_JOB_TIMEOUT: 'retryable',
  X_DRIVER_UNAVAILABLE: 'retryable',
  // A second `step.run` under one name is a defect in the handler, replayed identically forever.
  X_STEP_DUPLICATE: 'terminal',
  // A sweep whose source ran dry while its own count still matches rows: the next attempt resumes
  // at the cursor that just ran dry and diverges again.
  X_BACKFILL_STALLED: 'terminal',
  X_BACKFILL_ENVIRONMENT: 'terminal',
  X_BACKFILL_APPLIED: 'terminal',
});

/** Shared with `backfill-errors.ts`, which holds the seven `X_BACKFILL_*` classes. */
export const docsFor = (code: JobErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** An enqueue collided with a live job holding the same idempotency key under `onConflict: 'error'`. */
export class JobDuplicateError extends UltimateError {
  constructor(input: { job: string; idempotencyKey: string; existingId: string }) {
    super({
      code: 'X_JOB_DUPLICATE',
      cause: `job "${input.job}" already queued as ${input.existingId} with idempotencyKey "${input.idempotencyKey}"`,
      fix: 'pass onConflict: "dedupe" to enqueue, or make idempotencyKey narrower',
      docs: docsFor('X_JOB_DUPLICATE'),
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
      fix: `x jobs ls --json names the one already seated; rename the other's export, or its "name:" if it declares one — a ${input.kind} name is a durable queue key and is globally unique`,
      docs: docsFor('X_JOB_DUPLICATE'),
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
      docs: docsFor('X_JOB_ROW_STATUS_UNKNOWN'),
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
      docs: docsFor('X_ACTION_JOB_UNBRIDGED'),
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
      docs: docsFor('X_STEP_DUPLICATE'),
    });
  }
}

export class JobTimeoutError extends UltimateError {
  constructor(input: { job: string; timeoutMs: number; step?: string }) {
    super({
      code: 'X_JOB_TIMEOUT',
      cause:
        input.step === undefined
          ? `job "${input.job}" exceeded its ${input.timeoutMs}ms timeout`
          : `job "${input.job}" step "${input.step}" exceeded its ${input.timeoutMs}ms timeout`,
      fix: `raise timeout on the job definition, or split the work into step.run() calls`,
      docs: docsFor('X_JOB_TIMEOUT'),
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
  constructor(input: { job: string; step?: string }) {
    super({
      code: 'X_ABORTED',
      cause:
        input.step === undefined
          ? `job "${input.job}" was cancelled — this attempt no longer owns the run`
          : `job "${input.job}" was cancelled before step "${input.step}" could be recorded`,
      fix: 'add throwIfAborted(ctx) before expensive work, or pass fetch(url, { signal: ctx.signal }) — the queue re-runs the job, so stop at the deadline instead of running past it',
      docs: docsFor('X_ABORTED'),
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
      docs: docsFor('X_JOB_MAX_ATTEMPTS'),
    });
  }
}

export class DriverUnavailableError extends UltimateError {
  constructor(input: { driver: string; cause: string; fix: string }) {
    super({
      code: 'X_DRIVER_UNAVAILABLE',
      cause: `jobs driver "${input.driver}" is unavailable: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_DRIVER_UNAVAILABLE'),
    });
  }
}

/**
 * The type signature already requires `idempotencyKey`; this is the runtime backstop for
 * generated code and JS callers, so the guarantee holds at both ends.
 */
export class IdempotencyRequiredError extends UltimateError {
  constructor(input: { job: string }) {
    super({
      code: 'X_IDEMPOTENCY_REQUIRED',
      cause: `job "${input.job}" has no idempotencyKey — at-least-once delivery would run it twice`,
      fix: `add idempotencyKey: (input) => \`${input.job}:\${input.id}\` to the job definition`,
      docs: docsFor('X_IDEMPOTENCY_REQUIRED'),
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
      docs: docsFor('X_JOB_TENANT_REQUIRED'),
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
      docs: docsFor('X_JOB_LEASE_LOST'),
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
      docs: docsFor('X_JOB_SLOT_LOST'),
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
      fix: `x jobs ls --state running --json`,
      docs: docsFor('X_JOB_NOT_CANCELLABLE'),
    });
  }
}

/** The driver has no `introspect.cancel`. The redis/nats stubs, and any hand-rolled driver. */
export class CancelUnsupportedError extends UltimateError {
  constructor(input: { driver: string }) {
    super({
      code: 'X_JOB_NOT_CANCELLABLE',
      cause: `the "${input.driver}" jobs driver cannot cancel a single job`,
      fix: 'call setJobDriver(createPgDriver()) at boot — only the pg driver implements introspect.cancel — then: x jobs cancel <id> --json',
      docs: docsFor('X_JOB_NOT_CANCELLABLE'),
    });
  }
}

/**
 * `job.concurrency` is declared and this driver has no `leases`, so the cap is per PROCESS and the
 * fleet runs `concurrency x replicas`. Thrown at worker start rather than logged, because a
 * documented guarantee that silently does nothing is exactly what axiom 3 exists to refuse — the
 * worker refuses to start instead of running with the wrong number.
 */
export class ConcurrencyUnenforceableError extends UltimateError {
  constructor(input: { driver: string; jobs: readonly string[] }) {
    super({
      code: 'X_JOB_CONCURRENCY_UNENFORCEABLE',
      cause: `${input.jobs.join(', ')} declare concurrency and the "${input.driver}" jobs driver has no lease store, so the cap would hold per process and the fleet would run concurrency x replicas`,
      fix: `remove concurrency from job("${input.jobs[0] ?? 'the job'}"), or call setJobDriver(createPgDriver()) at boot — the pg driver is the one with a lease store`,
      docs: docsFor('X_JOB_CONCURRENCY_UNENFORCEABLE'),
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
      docs: docsFor('X_OUTBOX_NO_TX'),
    });
  }
}

export class JobsNotImplementedError extends UltimateError {
  constructor(input: { feature: string; fix: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `${input.feature} is declared but not implemented in @ultimat3/jobs`,
      fix: input.fix,
      docs: docsFor('X_NOT_IMPLEMENTED'),
    });
  }
}
