// Single responsibility: refuse a `retry.jitter` that is not core's `JitterMode`, at `job()`. A v30
// boolean from JS or JSON config otherwise splits in two: `backoffDelay` reads `true` as no jitter,
// the stated-delay path (`retry-classification.ts`) as jitter — one declaration, two meanings.

import type { JitterMode } from '@ultimat3/core';
import { renderCauseValue, UltimateError } from '@ultimat3/core';

const MODES: readonly JitterMode[] = ['none', 'equal', 'full'];

/**
 * The shipped `X_JOB_DECLARATION_INVALID`, not a code of its own: the same statement — this `job()`
 * call cannot be seated as written — and the same repair, an edit to the declaration.
 */
export class JobRetryJitterInvalidError extends UltimateError {
  constructor(input: { job: string; declared: unknown }) {
    // What a v30 boolean meant, so the fix names the exact replacement: true → 'equal', false → 'none'.
    const mapped: JitterMode = input.declared === false ? 'none' : 'equal';
    super({
      code: 'X_JOB_DECLARATION_INVALID',
      cause: `job "${input.job}" declares retry.jitter ${renderCauseValue(input.declared)}, which is not one of 'none' | 'equal' | 'full' — a v30 boolean would mean no jitter to the backoff and jitter to a stated delay`,
      fix: `jitter: '${mapped}',   # in job('${input.job}')'s retry — v30's boolean maps true → 'equal', false → 'none'; omitted is 'equal'`,
      meta: { job: input.job, field: 'retry.jitter' },
    });
  }
}

/** `undefined` is the default; anything else must be a `JitterMode`, read as `unknown` on purpose. */
export function assertRetryJitter(job: string, jitter: unknown): void {
  if (jitter === undefined) return;
  if (MODES.some((mode) => mode === jitter)) return;
  throw new JobRetryJitterInvalidError({ job, declared: jitter });
}
