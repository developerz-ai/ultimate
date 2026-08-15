// The X_* codes owned by @ultimat3/jobs. Every one names the command or code change that
// fixes it — a job failure an agent cannot act on is a job failure that gets retried forever.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const JOB_OWNED_ERROR_CODES = [
  'X_JOB_DUPLICATE',
  'X_STEP_DUPLICATE',
  'X_JOB_TIMEOUT',
  'X_JOB_MAX_ATTEMPTS',
  'X_DRIVER_UNAVAILABLE',
  'X_IDEMPOTENCY_REQUIRED',
  'X_OUTBOX_NO_TX',
  'X_BACKFILL_PENDING',
  'X_BACKFILL_APPLIED',
  'X_BACKFILL_ENVIRONMENT',
  'X_BACKFILL_MIGRATION_PENDING',
  'X_BACKFILL_RUNNING',
  'X_BACKFILL_STALLED',
  'X_BACKFILL_UNKNOWN',
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
  X_OUTBOX_NO_TX: 'enqueue outside a transaction',
  X_BACKFILL_PENDING: 'a declared backfill has never completed',
  X_BACKFILL_APPLIED: 'the ledger already holds a completed pass',
  X_BACKFILL_ENVIRONMENT: 'the backfill is not declared for this environment',
  X_BACKFILL_MIGRATION_PENDING: 'the migration this backfill requires is not applied',
  X_BACKFILL_RUNNING: 'a pass under this name is already live',
  X_BACKFILL_STALLED: 'the sweep ended with rows its own count still matches',
  X_BACKFILL_UNKNOWN: 'no declaration carries this backfill name',
};

// One unconditional call, so a second package claiming one of jobs' codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(JOB_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: JobErrorCode): string => `https://ultimate.dev/errors/${code}`;

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

/**
 * The seven backfill codes below all answer one question — "why is this sweep not running?" — and
 * each is here because it sends the reader somewhere different: run it, force it, change
 * environment, migrate first, wait, fix the predicates, or fix the name. A code that shared a fix
 * line with another one would be code inflation, which is why `X_BACKFILL_WRITE_UNCONFIRMED` was
 * considered and rejected: a dry run that wrote nothing did exactly what it was asked to.
 *
 * Every `fix` below is ONE line something can execute — a shell command, or the edit to make.
 * Never a command with prose appended: a `fix:` is copied and run verbatim, so a trailing clause
 * turns a working command into a syntax error at the one moment the reader is following it
 * literally. Explanations belong in `cause`, which is read and never run.
 */

/**
 * Declared and never completed. The alarm the framework did not have: an author could
 * `x g backfill`, merge and deploy, and nothing anywhere said the pass had not run.
 */
export class BackfillPendingError extends UltimateError {
  constructor(input: { backfill: string; environment: string }) {
    super({
      code: 'X_BACKFILL_PENDING',
      cause: `backfill "${input.backfill}" is declared and x_backfills holds no completed pass for it in ${input.environment}`,
      fix: `x db backfill ${input.backfill} --write --json`,
      docs: docsFor('X_BACKFILL_PENDING'),
    });
  }
}

/** Already swept. A rerun is legitimate, so this names the flag rather than refusing outright. */
export class BackfillAppliedError extends UltimateError {
  constructor(input: { backfill: string; runId: string; completedAt: string }) {
    super({
      code: 'X_BACKFILL_APPLIED',
      cause: `backfill "${input.backfill}" completed as run ${input.runId} at ${input.completedAt}; a forced rerun writes a NEW ledger row and never edits that one`,
      fix: `x db backfill ${input.backfill} --write --force --json`,
      docs: docsFor('X_BACKFILL_APPLIED'),
    });
  }
}

/**
 * The declaration names the environments it belongs to and this is not one. Declared DATA, never a
 * hardcoded "cleanups are production": a staging rehearsal is correct practice, so which
 * environments a sweep belongs to is the app's convention and this is only the mechanism carrying
 * it (axiom 8).
 */
export class BackfillEnvironmentError extends UltimateError {
  constructor(input: { backfill: string; environment: string; declared: readonly string[] }) {
    // The first declared environment, because the fix has to be ONE runnable line and the list is
    // ordered by the author. The empty case cannot arise from `checkBackfillEnvironment`, which
    // treats an empty list as "every environment" — but this constructor is public, so it answers
    // with the command that lists what IS declared rather than an `ULTIMATE_ENV=undefined`.
    const target = input.declared[0];
    super({
      code: 'X_BACKFILL_ENVIRONMENT',
      cause: `backfill "${input.backfill}" declares environments: ${input.declared.join(', ')} and this process resolved ${input.environment} — add "${input.environment}" to that list if this deploy should sweep too`,
      fix:
        target === undefined
          ? 'x db backfill --pending --json'
          : `ULTIMATE_ENV=${target} x db backfill ${input.backfill} --write --json`,
      docs: docsFor('X_BACKFILL_ENVIRONMENT'),
    });
  }
}

/**
 * `requires` names a migration the ledger has not applied. Checked where `x_migrations` is
 * readable — this package holds no `@ultimat3/db` dependency and growing one to read a ledger
 * would put the migration engine on the tier-3 queue's import graph.
 */
export class BackfillMigrationPendingError extends UltimateError {
  constructor(input: { backfill: string; migration: string }) {
    super({
      code: 'X_BACKFILL_MIGRATION_PENDING',
      cause: `backfill "${input.backfill}" requires migration ${input.migration}, which x_migrations does not record as applied`,
      fix: 'x db migrate --json',
      docs: docsFor('X_BACKFILL_MIGRATION_PENDING'),
    });
  }
}

/**
 * The enqueue deduped: one live pass per name, so this run is the one already going. Distinct from
 * `X_BACKFILL_APPLIED`, which is a pass that finished — the response there is `--force`, and the
 * response here is to look at the run that is holding the key.
 */
export class BackfillRunningError extends UltimateError {
  constructor(input: { backfill: string; jobId: string }) {
    super({
      code: 'X_BACKFILL_RUNNING',
      cause: `backfill "${input.backfill}" already has a live pass queued as ${input.jobId}, and one name holds one live pass; its step trace names the batch it is on, and a pass that is not advancing is a worker that lost its lease`,
      fix: `x jobs show ${input.jobId} --json`,
      docs: docsFor('X_BACKFILL_RUNNING'),
    });
  }
}

/**
 * The source ran out of rows and the declaration's own `count()` still matches some. Two
 * predicates that disagree is an authoring bug in any business — the sweep reported success over
 * rows it never visited — so the pass fails rather than writing a completed row nobody can trust.
 */
export class BackfillStalledError extends UltimateError {
  constructor(input: { backfill: string; remaining: number; swept: number }) {
    super({
      code: 'X_BACKFILL_STALLED',
      cause: `backfill "${input.backfill}" swept ${input.swept} rows, exhausted its source, and count() still matches ${input.remaining} — a WHERE the sweep narrows and the count does not is what leaves rows behind`,
      fix: `make count() select on exactly what source() selects on in backfill("${input.backfill}")`,
      docs: docsFor('X_BACKFILL_STALLED'),
    });
  }
}

/** A name no declaration in this app carries — a typo, or a backfill whose module was deleted. */
export class BackfillUnknownError extends UltimateError {
  constructor(input: { backfill: string; known: readonly string[] }) {
    super({
      code: 'X_BACKFILL_UNKNOWN',
      cause:
        input.known.length === 0
          ? `no backfill named "${input.backfill}" is declared, and this app declares none at all`
          : `no backfill named "${input.backfill}" is declared (declared: ${input.known.join(', ')})`,
      fix: 'x db backfill --pending --json',
      docs: docsFor('X_BACKFILL_UNKNOWN'),
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
