// Single responsibility: the refusals a named `limiter()` earns — a declaration no worker can
// honour, a run over the fleet's rate or concurrency, and a driver with no lease store to count in.
// Every code is SHIPPED and borrowed for the meaning it already has: a limiter adds no code.

import { renderCauseValue, UltimateError } from '@ultimat3/core';

/**
 * `limiter(name, { … })` written with a member no worker can honour, or a second declaration of
 * one name with different numbers — two answers to "what is the budget" on one set of lease rows.
 * `X_JOB_DECLARATION_INVALID`, as `concurrency: 0` on a job is: the same repair, an edit.
 */
export class LimiterDeclarationInvalidError extends UltimateError {
  constructor(input: { limiter: string; field: string; declared: unknown; why: string }) {
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `limiter "${input.limiter}" declares ${input.field} ${renderCauseValue(input.declared)}, ${input.why}`,
      fix: `export const budget = limiter('${input.limiter}', { rate: { limit: 10, windowMs: 1_000 }, concurrency: 4 }); — once, at module scope, whole numbers of at least 1, either member or both; import that value into every job({ limiter }) that spends it`,
      meta: { limiter: input.limiter, field: input.field },
    });
  }
}

export type LimiterRefusal = 'rate' | 'concurrency';

/**
 * The run's start is over the fleet budget. `X_RATE_LIMITED` on purpose — the code `executeJob`
 * already reads as "not yet": the run is deferred to `retryAfterSeconds` with its attempt
 * UNCOUNTED (`rateLimitDeferralMs`), so a backlog waits for the budget and is never dead-lettered
 * for having waited.
 */
export class LimiterRefusedError extends UltimateError {
  constructor(input: {
    limiter: string;
    job: string;
    refusal: LimiterRefusal;
    retryAfterSeconds: number;
  }) {
    const what =
      input.refusal === 'rate'
        ? 'has spent its rate for this window'
        : 'already holds its concurrency in running jobs';
    super({
      code: 'X_RATE_LIMITED',
      cause: `job "${input.job}" spends limiter "${input.limiter}", which ${what} across the fleet; the run is deferred ${input.retryAfterSeconds}s with its attempt uncounted`,
      fix: `limiter('${input.limiter}', { rate: { limit: 20, windowMs: 1_000 } }) — raise rate or concurrency where it is declared, or leave it: the run waits for the budget`,
      meta: {
        limiter: input.limiter,
        job: input.job,
        refusal: input.refusal,
        retryAfterSeconds: input.retryAfterSeconds,
      },
    });
  }
}

/**
 * A job spends a limiter and the installed driver has no `leases`, so the budget would hold per
 * process and the fleet would spend it once per replica. `X_JOB_CONCURRENCY_UNENFORCEABLE`, the
 * code `job.concurrency` already earns for the same missing store.
 */
export class LimiterUnenforceableError extends UltimateError {
  constructor(input: { limiter: string; job: string; driver: string }) {
    super({
      code: 'X_JOB_CONCURRENCY_UNENFORCEABLE',
      cause: `job "${input.job}" spends limiter "${input.limiter}" and the "${input.driver}" jobs driver has no lease store, so the budget would hold per process and the fleet would spend it once per replica`,
      fix: `jobs: postgresJobDriver() in apps/<app>/runtime.ts, or no jobs: field at all (the boot installs it over DATABASE_URL) — the driver with a lease store; else remove limiter from job("${input.job}")`,
      meta: { limiter: input.limiter, job: input.job, driver: input.driver },
    });
  }
}
