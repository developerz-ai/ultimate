// The driver half of a tenant's own read and cancel of ONE job: the port every driver implements
// (`JobDriver.tenantJobs`), fenced on the tenant INSIDE the store, so a row of another tenant and
// a row that does not exist are the same answer from the same single lookup. The public half —
// what a caller may see of the row — is `job-status.ts`.

import type { JobRecord } from './driver';
import type { JobProgress } from './introspection';

/** Which job, asked for by whom. `name`, when given, is part of the fence too. */
export interface TenantJobQuery {
  readonly jobId: string;
  /** The tenant the row must be queued for. A row queued for no tenant never matches. */
  readonly tenantId: string;
  readonly name?: string;
}

/**
 * The columns a tenant fence reads — never `input`, `lastError`, its stack, `traceparent`,
 * `enqueuedBy` or the claim: a driver answers only what `JobStatus` may show.
 */
export type JobStatusRow = Pick<
  JobRecord,
  'id' | 'name' | 'state' | 'attempt' | 'maxAttempts' | 'runAt' | 'createdAt' | 'updatedAt'
> & { readonly progress?: JobProgress };

export interface TenantJobs {
  /** The row, when one with this id is queued for this tenant (and of this name); else nothing. */
  status(query: TenantJobQuery): Promise<JobStatusRow | undefined>;
  /**
   * Cancels the row when it is live — the operator `cancel`'s write, under the same fence as
   * `status` — and answers it as it now stands: `cancelled`, or the finished state it already had.
   * No row under the fence answers nothing and writes nothing.
   */
  cancel(query: TenantJobQuery, reason?: string): Promise<JobStatusRow | undefined>;
}
