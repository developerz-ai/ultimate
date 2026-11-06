// The refusals of durable compensation and at-most-once steps: a step name the framework reserves,
// a `compensate` its job did not declare, a `once` step whose outcome nobody knows, an unwind that
// could not finish, and a resolve with nothing to resolve. The codes are in `error-codes.ts`.

import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';

/** The step the framework writes before the first compensator: the durable "this run unwinds". */
export const UNWINDING_STEP = 'unwinding';
/** Each compensator runs as an ordinary step under this prefix, so a replay skips what ran. */
export const COMPENSATE_PREFIX = 'compensate:';

/** A body named a step the framework writes itself. Refused for every job, `compensates` or not. */
export class StepNameReservedError extends UltimateError {
  constructor(input: { job: string; step: string }) {
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" names a step "${input.step}", and "${UNWINDING_STEP}" and "${COMPENSATE_PREFIX}*" are the names compensation writes`,
      fix: `step.run('<another name>', …)   # in job('${input.job}'), instead of "${input.step}": "${UNWINDING_STEP}" and "${COMPENSATE_PREFIX}*" are compensation's`,
      meta: { job: input.job, step: input.step },
    });
  }
}

/** `step.run(…, { compensate })` in a job that never declared it compensates. */
export class StepCompensateUndeclaredError extends UltimateError {
  constructor(input: { job: string; step: string }) {
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" step "${input.step}" passes compensate, and the job does not declare compensates: true, so nothing would ever run it`,
      fix: `job({ name: '${input.job}', compensates: true, … })   # or drop compensate from step.run('${input.step}', …)`,
      meta: { job: input.job, step: input.step },
    });
  }
}

/** A `once` step has a `started` (or `failed`) record and no `completed` one: did it happen? */
export class StepOutcomeUnknownError extends UltimateError {
  constructor(input: { job: string; step: string }) {
    super({
      code: 'X_STEP_OUTCOME_UNKNOWN',
      cause: `job "${input.job}" step "${input.step}" is declared once, it started on an earlier attempt and never completed, so whether it ran is unknown and running it again could do it twice`,
      fix: `x jobs resolve-step <id> ${renderFixShellArg(input.step, '<step>')} --ran --output '<json>'   # or --not-ran to run it again; then x jobs retry <id>`,
      meta: { job: input.job, step: input.step },
    });
  }
}

/**
 * The unwind stopped: a compensator spent the unwind's attempts, or it reached a `once` step whose
 * outcome is unknown — undoing something that may not have happened is a person's call.
 */
export class JobCompensationFailedError extends UltimateError {
  constructor(input: {
    job: string;
    step: string;
    outcome: 'failed' | 'unknown';
    reason: string;
  }) {
    const unknown = input.outcome === 'unknown';
    super({
      code: 'X_JOB_COMPENSATION_FAILED',
      cause: unknown
        ? `job "${input.job}" is unwinding and step "${input.step}" is once with an unknown outcome (X_STEP_OUTCOME_UNKNOWN), so its compensator cannot know whether there is anything to undo`
        : `job "${input.job}" is unwinding and the compensator of step "${input.step}" failed: ${input.reason}`,
      fix: unknown
        ? `x jobs resolve-step <id> ${renderFixShellArg(input.step, '<step>')} --ran --output '<json>'   # or --not-ran; then x jobs retry <id>, and completed compensators replay`
        : `x jobs retry <id>   # once the compensate of step.run('${input.step}', …) in job('${input.job}') is repaired: completed compensators replay`,
      meta: { job: input.job, step: input.step, outcome: input.outcome },
    });
  }
}

/** Whether `name` is one the framework writes: refused when a body asks for it. */
export const isReservedStepName = (name: string): boolean =>
  name === UNWINDING_STEP || name.startsWith(COMPENSATE_PREFIX);

/** `x jobs resolve-step` on a running job, or on a step that has no unknown outcome to answer. */
export class StepNotResolvableError extends UltimateError {
  constructor(input: { jobId: string; step: string; state: string; status: string }) {
    super({
      code: 'X_STEP_NOT_RESOLVABLE',
      cause: `job ${renderCauseValue(input.jobId)} is ${input.state} and its step ${renderCauseValue(input.step)} is ${input.status}: only a step that started (or failed) and never completed, on a job no worker holds, has an outcome to resolve`,
      fix: `x jobs show ${renderFixShellArg(input.jobId, '<job id>')} --json   # read the steps: resolve one whose status is started or failed, once the job has settled`,
      meta: { jobId: input.jobId, step: input.step, state: input.state, status: input.status },
    });
  }
}
