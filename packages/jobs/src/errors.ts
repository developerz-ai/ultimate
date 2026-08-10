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
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. `JobsNotImplementedError` below throws it; jobs keeps
 * no title for it, because the copy this file used to hold was a second title that nothing would
 * have failed on once core's changed.
 */
export const JOB_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

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
 * Two different handles claim one name at registration. Shares `X_JOB_DUPLICATE` with the
 * enqueue-time collision because it is the same statement — this key already belongs to another
 * job — caught one stage earlier. Left unrefused, the second registration would silently take
 * over delivery of every row already queued under the first.
 */
export class JobNameTakenError extends UltimateError {
  constructor(input: { kind: 'job' | 'task'; name: string }) {
    super({
      code: 'X_JOB_DUPLICATE',
      cause: `two ${input.kind}s are registered under the name "${input.name}"`,
      fix: `rename one export — a ${input.kind} name is the durable queue key and is globally unique: x jobs ls --json`,
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
