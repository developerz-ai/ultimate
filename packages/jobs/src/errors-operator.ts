// Single responsibility: the refusals the operator surface gives — a job that cannot be removed
// or promoted, a page it cannot answer — and the one failure it only ever reports, a settled
// run's `onSettled` hook. Its own
// module because `errors.ts` sits at the size ceiling; the codes are registered there.

import { isFixShellSafe, renderFixShellArg, renderThrowable, UltimateError } from '@ultimat3/core';

/** A command over one job id, or the listing when the id would not survive a shell verbatim. */
const jobCommand = (verb: string, jobId: string): string =>
  isFixShellSafe(jobId)
    ? `x jobs ${verb} ${renderFixShellArg(jobId, 'id')} --json`
    : 'x jobs ls --state running --json';

/** `remove()` / `removeMany()` reached a job a worker holds. Cancel stops the body; then remove. */
export class JobNotRemovableError extends UltimateError {
  constructor(input: { jobId?: string }) {
    super({
      code: 'X_JOB_NOT_REMOVABLE',
      cause:
        input.jobId === undefined
          ? 'a bulk remove named the running state, and a row a worker holds cannot be deleted under its body'
          : `job ${input.jobId} is running, and deleting the row under its body would not stop the body`,
      fix:
        input.jobId === undefined
          ? 'x jobs ls --state running --json'
          : jobCommand('cancel', input.jobId),
      meta: { ...(input.jobId === undefined ? {} : { jobId: input.jobId }) },
    });
  }
}

/** `promote()` reached a job that is not waiting on its `runAt`. */
export class JobNotPromotableError extends UltimateError {
  constructor(input: { jobId: string; state: string }) {
    super({
      code: 'X_JOB_NOT_PROMOTABLE',
      cause:
        input.state === 'missing'
          ? `no job ${input.jobId} exists in this queue`
          : `job ${input.jobId} is ${input.state} and is not waiting on its run time — only a delayed job, or one backing off before a retry, can be promoted`,
      fix: jobCommand('show', input.jobId),
      meta: { jobId: input.jobId, state: input.state },
    });
  }
}

/**
 * Built to be LOGGED and reported, never thrown at a caller: the run is already settled, the hook
 * is the app's reaction to that, and a reaction that fails is not a reason to settle it again.
 */
export class JobOnSettledFailedError extends UltimateError {
  constructor(input: {
    job: string;
    jobId: string;
    outcome: string;
    attempts: number;
    error: unknown;
  }) {
    super({
      code: 'X_JOB_ON_SETTLED_FAILED',
      cause: `onSettled for job "${input.job}" (${input.jobId}, ${input.outcome}) failed ${input.attempts} time(s): ${renderThrowable(input.error)}`,
      fix: jobCommand('show', input.jobId),
      meta: {
        job: input.job,
        jobId: input.jobId,
        outcome: input.outcome,
        attempts: input.attempts,
      },
    });
  }
}

/**
 * `list()` was asked for a page it does not answer: more rows than one page holds, or a cursor no
 * page produced. Its own code, never the bare invariant it was: the reader is a dashboard author
 * with a `limit` in a query string, and what they need is the bound by name and the call that
 * walks past it. `MAX_JOB_PAGE` is passed in — `introspection.ts` owns it and imports this file.
 */
export class JobPageInvalidError extends UltimateError {
  constructor(input: { subject: string; maxPage: number; limit?: number }) {
    super({
      code: 'X_JOB_PAGE_INVALID',
      cause:
        input.limit === undefined
          ? `${input.subject} was handed an after cursor that no previous page produced`
          : `${input.subject} limit is ${input.limit}, over MAX_JOB_PAGE (${input.maxPage}) — the rows one page may answer`,
      fix: `list({ limit: ${input.maxPage}, after: jobCursor(lastRow) })   # lastRow is the last row of the page before; omit after for the first page, and stop at a page shorter than its limit`,
      meta: {
        maxPage: input.maxPage,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    });
  }
}
