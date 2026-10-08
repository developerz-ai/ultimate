// Single responsibility: the refusals `job.concurrency` earns — a cap mis-declared, a key that
// cannot name a lease, a key already holding its limit, and a driver that cannot hold the cap.
// Its own module because `errors.ts` sits at the size ceiling; the CODES are registered there,
// beside every other jobs code.

import { isFixShellSafe, renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';

/**
 * `concurrency: { key, limit, whenBusy }` declared with a member no worker can honour. The shipped
 * `X_JOB_DECLARATION_INVALID` and not a code of its own: it is the same statement — this `job()`
 * call cannot be seated as written — and the same repair, an edit to the declaration.
 *
 * `declared` is rendered by core's total reader, never interpolated: it arrives from generated
 * code and JS callers, which is the only way a value the type forbids reaches here at all.
 */
export class JobConcurrencyInvalidError extends UltimateError {
  constructor(input: { job: string; field: string; declared: unknown; why: string; edit: string }) {
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" declares ${input.field} ${renderCauseValue(input.declared)}, ${input.why}`,
      fix: `${input.edit} on job('${input.job}')`,
      meta: { job: input.job, field: input.field },
    });
  }
}

/** Why a key cannot name a lease. `unreadable` is a key function that answered a non-string. */
export type ConcurrencyKeyDefect = 'empty' | 'unreadable' | 'too-long';

const KEY_DEFECT_CAUSE = Object.freeze<Record<ConcurrencyKeyDefect, string>>({
  empty:
    'answered an empty string for this input — an empty key is one lock shared by every run, which nobody declared',
  unreadable: 'answered something that is not a string, and a lease is keyed by text',
  'too-long': 'answered a key longer than a lease row can be keyed by',
});

/**
 * `concurrency.key(input)` answered a value that cannot key a lease — refused where the run is
 * ENQUEUED, because that is the first moment an input exists to ask the function about.
 *
 * The key itself never reaches the cause or the meta: it is computed from an input, so it is app
 * data, and this error is logged by whatever caught the enqueue.
 */
export class JobConcurrencyKeyInvalidError extends UltimateError {
  constructor(input: { job: string; defect: ConcurrencyKeyDefect; maxLength: number }) {
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" concurrency.key ${KEY_DEFECT_CAUSE[input.defect]}`,
      fix: `return a non-empty string of at most ${input.maxLength} characters from concurrency.key on job('${input.job}') — key: (input) => input.accountId — or declare concurrency: 1 for one cap across every run`,
      meta: { job: input.job, defect: input.defect },
    });
  }
}

/**
 * A run claimed under `whenBusy: 'fail'` while its key already held `limit` runs. The run settles
 * `failed` with this as its `lastError`, its body never runs and nothing retries it — the declared
 * answer to "a second run of this key", which is why it is neither a dead letter nor a fault.
 */
export class JobKeyBusyError extends UltimateError {
  constructor(input: { job: string; key: string; limit: number }) {
    super({
      code: 'X_JOB_KEY_BUSY',
      cause: `job "${input.job}" key ${renderCauseValue(input.key)} already holds ${input.limit} run(s)`,
      // A name the shell would not read verbatim drops the filter rather than travelling as a
      // placeholder: `--name <job>` is a redirection, and a fix that fails is no fix. The splice
      // still goes through `renderFixShellArg` — the screen `bun run error-render` looks for —
      // whose placeholder the guard above makes unreachable.
      fix: isFixShellSafe(input.job)
        ? `x jobs list --name ${renderFixShellArg(input.job, 'job')} --state running --json`
        : 'x jobs list --state running --json',
      meta: { job: input.job, key: input.key, limit: input.limit },
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
      fix: `remove concurrency from job("${input.jobs[0] ?? 'the job'}"), or call setJobDriver(postgresJobDriver()) at boot — the pg driver is the one with a lease store`,
    });
  }
}
