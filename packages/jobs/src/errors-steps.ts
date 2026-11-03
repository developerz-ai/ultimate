// The two refusals a step answer can raise: a value JSON cannot hold, and a waited event its schema
// refuses. Both are terminal, and their codes stay declared in `errors.ts`.

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
