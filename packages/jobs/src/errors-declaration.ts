// Single responsibility: the refusal a `job()` declaration earns when it lacks a field every job
// declares. Its own module because `errors.ts` sits at the size ceiling; the CODE is registered
// there, beside every other jobs code, and only the constructor lives here.

import { UltimateError } from '@ultimat3/core';

/** The edit each required `job()` field takes, for `JobDeclarationInvalidError`'s fix line. */
const REQUIRED_FIELD_FIX = Object.freeze<Record<string, string>>({
  input: 'input: t.object({ … })',
  idempotencyKey: `idempotencyKey: (input) => \`<name>:\${input.id}\``,
  tenant: "tenant: (input) => input.orgId — or tenant: 'none' for a job no org owns",
  retry: "retry: { attempts: 5, backoff: 'exponential' }",
  run: 'run: async ({ input, step }) => { … }',
});

/**
 * `job()` called without one or more fields the type requires — generated code and JS callers.
 * EVERY missing field in one refusal: a missing `retry` used to crash the app loader with a bare
 * `TypeError … definition.retry.attempts`, reported as `X_CLI_UNEXPECTED`, and fixing fields one
 * restart at a time is the slow way to learn a declaration.
 */
export class JobDeclarationInvalidError extends UltimateError {
  constructor(input: { job: string; missing: readonly string[] }) {
    const edits = input.missing.map((field) =>
      Object.hasOwn(REQUIRED_FIELD_FIX, field) ? REQUIRED_FIELD_FIX[field] : field,
    );
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" is missing ${input.missing.join(', ')}, which every job declares`,
      fix: `set ${edits.join('; ')} on job('${input.job}')`,
      meta: { job: input.job, missing: [...input.missing] },
    });
  }
}
