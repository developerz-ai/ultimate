// The one refusal for a job whose PAYLOAD and declared tenant disagree — a webhook delivery's
// `orgId` that is not the org the run is under, a tenant that derives no org from the payload, an
// agent actor resolved in another org. Its code stays declared in `errors.ts`, classified terminal.

import { UltimateError } from '@ultimat3/core';

export class JobTenantMismatchError extends UltimateError {
  constructor(input: {
    readonly job: string;
    /** What disagrees, in words — org ids only; never a secret, never a row. */
    readonly reason: string;
    /** The enqueue, or the declaration, that repairs it — specific to the caller. */
    readonly fix: string;
  }) {
    super({
      code: 'X_JOB_TENANT_MISMATCH',
      cause: `job "${input.job}" ${input.reason} — the same payload is refused on every attempt, so it is dead-lettered on this one`,
      fix: input.fix,
      meta: { job: input.job },
    });
  }
}
