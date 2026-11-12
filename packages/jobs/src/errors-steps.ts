// The refusals a step answer can raise: a value JSON cannot hold, a value past the job's byte
// ceiling, and a waited event its schema refuses. All terminal; codes declared in `error-codes.ts`.

import { UltimateError } from '@ultimat3/core';

/** `step.run`'s body answered what a store cannot hold faithfully, so no attempt could replay it. */
export class StepOutputUnserializableError extends UltimateError {
  constructor(input: { job: string; step: string; reason: string }) {
    super({
      code: 'X_STEP_OUTPUT_UNSERIALIZABLE',
      cause: `job "${input.job}" step "${input.step}" answered a value JSON cannot hold (${input.reason}), so no attempt could replay it`,
      fix: `step.run('${input.step}', () => String(id))   # return plain JSON: String(id) for a bigint, the ids rather than the object graph, null rather than NaN or an invalid Date, text with no NUL and no lone surrogate`,
      meta: { job: input.job, step: input.step },
    });
  }
}

/**
 * `step.run`'s body answered more JSON bytes than the job's declared `stepOutputMax`; past the
 * undeclared default it is only logged, with this code and fix (`steps-output.ts`). Every attempt
 * loads every output of its run (`steps.ts` hydration), so a page or a file kept in a step costs
 * its size times the run's steps on every retry. The step's side effect has happened; nothing is
 * recorded.
 */
export class StepOutputTooLargeError extends UltimateError {
  constructor(input: { job: string; step: string; bytes: number; maxBytes: number }) {
    super({
      code: 'X_STEP_OUTPUT_TOO_LARGE',
      cause: `job "${input.job}" step "${input.step}" answered ${input.bytes} bytes of JSON, past the ${input.maxBytes}-byte ceiling a step output may hold`,
      fix: `step.run('${input.step}', async () => { await storage.put(key, bytes); return key; })   # persist the payload and return its key or cursor, as export() and backfill() do — or job({ name: '${input.job}', stepOutputMax: ${input.bytes} }) when the output really is that size`,
      meta: { job: input.job, step: input.step, bytes: input.bytes, maxBytes: input.maxBytes },
    });
  }
}

/**
 * The event `step.waitForEvent` found fails the wait's own schema, on a hit or on a replay.
 *
 * Terminal rather than skipped: skipping hides the publisher's bug until the timeout. `issues` come
 * from `formatIssues`, and the payload itself is never echoed, because an event can carry anything.
 * The wait records the refused event as its floor, so after the retry the fix names, it answers to
 * the next one published rather than finding this one again.
 */
export class JobEventInvalidError extends UltimateError {
  constructor(input: { job: string; step: string; event: string; issues: readonly string[] }) {
    super({
      code: 'X_JOB_EVENT_INVALID',
      cause: `job "${input.job}" step "${input.step}" found event "${input.event}", and it fails the wait's schema: ${input.issues.join('; ')}`,
      fix: `x jobs retry <id>   # after the publisher of "${input.event}" sends what the schema of step.waitForEvent('${input.step}', …) declares, or that schema is widened`,
      meta: { job: input.job, step: input.step, event: input.event },
    });
  }
}
