// The pg driver's `tenantJobs`: the tenant fence IN each statement, so a row of another tenant and
// a missing row are the same primary-key probes returning nothing — no row crosses the wire to be
// compared, and the two take the same plans.

import type { PgExecutor } from '@ultimat3/core';
import type { JobStatusPgRow } from './driver-pg-rows';
import { toJobStatusRow } from './driver-pg-rows';
import type { TenantJobs } from './job-status-port';

/** `JobStatusRow`'s columns, instants as epoch ms — `JOB_ROW_COLUMNS`' spelling, cut down. */
const STATUS_COLUMNS = `id, name, state, attempt, max_attempts, progress,
       (extract(epoch from run_at)     * 1000)::bigint as run_at,
       (extract(epoch from created_at) * 1000)::bigint as created_at,
       (extract(epoch from updated_at) * 1000)::bigint as updated_at`;

/**
 * `$1` id, `$2` tenant, `$3` name or null. `tenant_id = $2`, never `coalesce`: a row queued for no
 * tenant matches no tenant's call.
 */
const FENCE = `id = $1 and tenant_id = $2 and ($3::text is null or name = $3::text)`;

export const SQL_JOB_STATUS_FOR = `
select ${STATUS_COLUMNS}
  from x_jobs
 where ${FENCE}
`.trim();

/**
 * `SQL_CANCEL` under the tenant fence: the live row cancelled and answered. No row means nothing
 * live to cancel — and the caller re-reads in a SECOND statement, never an arm of this one: a
 * cancel parked on a settle's row lock finds the row finished once it commits, and an arm of the
 * same statement reads the snapshot it began on, which still says `running`. `$4` the reason.
 */
export const SQL_JOB_CANCEL_FOR = `
update x_jobs
   set state = 'cancelled', visible_at = null, claimed_by = null,
       last_error = coalesce($4, last_error), updated_at = now()
 where ${FENCE} and state in ('ready', 'delayed', 'running', 'suspended')
returning ${STATUS_COLUMNS}
`.trim();

export function pgTenantJobs(exec: () => PgExecutor): TenantJobs {
  const status: TenantJobs['status'] = async (query) => {
    const rows = await exec().query<JobStatusPgRow>(SQL_JOB_STATUS_FOR, [
      query.jobId,
      query.tenantId,
      query.name ?? null,
    ]);
    const row = rows[0];
    return row === undefined ? undefined : toJobStatusRow(row);
  };
  return {
    status,
    async cancel(query, reason) {
      const rows = await exec().query<JobStatusPgRow>(SQL_JOB_CANCEL_FOR, [
        query.jobId,
        query.tenantId,
        query.name ?? null,
        reason ?? null,
      ]);
      const row = rows[0];
      // Its own statement, so its own snapshot: the state the settle that beat this cancel wrote.
      return row === undefined ? status(query) : toJobStatusRow(row);
    },
  };
}
