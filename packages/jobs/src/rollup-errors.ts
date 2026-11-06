// Single responsibility: the two declaration refusals of the job factories over a derived table —
// `rollup()` and `refreshView()`. Their own module beside `backfill-errors.ts`; the codes are
// registered in `error-codes.ts` with every other jobs code.

import { UltimateError } from '@ultimat3/core';

export class RollupInvalidError extends UltimateError {
  constructor(input: { rollup: string; problem: string; fix: string }) {
    super({
      code: 'X_JOB_ROLLUP_INVALID',
      cause: `rollup "${input.rollup}" ${input.problem}`,
      fix: input.fix,
      meta: { rollup: input.rollup },
    });
  }
}

export class RefreshViewInvalidError extends UltimateError {
  constructor(input: { job: string; problem: string; fix: string }) {
    super({
      code: 'X_JOB_REFRESH_VIEW_INVALID',
      cause: `refreshView "${input.job}" ${input.problem}`,
      fix: input.fix,
      meta: { job: input.job },
    });
  }
}
