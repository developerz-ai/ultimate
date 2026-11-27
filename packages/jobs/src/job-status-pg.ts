// The pg driver's `tenantJobs`: the tenant fence IN the statement, so a row of another tenant and
// a missing row are the same primary-key probe returning nothing — no row crosses the wire to be
// compared, and the two take the same plan.

import type { PgExecutor } from '@ultimat3/core';
import type { JobStatusPgRow } from './driver-pg-rows';
import { toJobStatusRow } from './driver-pg-rows';
import type { TenantJobs } from './job-status-port';

/** `JobStatusRow`'s columns, instants as epoch ms — `JOB_ROW_COLUMNS`' spelling, cut down. */
const STATUS_COLUMNS = `id, name, state, attempt, max_attempts, progress,
       (extract(epoch from run_at)     * 1000)::bigint as run_at,
       (extract(epoch from created_at) * 1000)::bigint as created_at,
       (extract(epoch from updated_at) * 1000)::bigint as updated_at`;

/** The same columns read off a derived table, by their output names. */
const STATUS_NAMES =
  'id, name, state, attempt, max_attempts, progress, run_at, created_at, updated_at';

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
 * `SQL_CANCEL` under the tenant fence, in ONE statement: the live row cancelled and answered, or —
 * when nothing was live to cancel — the fenced row as it stands (its snapshot predates the update,
 * which is why the second arm waits on `not exists (select 1 from hit)`). `$4` the reason.
 */
export const SQL_JOB_CANCEL_FOR = `
with hit as (
  update x_jobs
     set state = 'cancelled', visible_at = null, claimed_by = null,
         last_error = coalesce($4, last_error), updated_at = now()
   where ${FENCE} and state in ('ready', 'delayed', 'running', 'suspended')
  returning ${STATUS_COLUMNS}
)
select ${STATUS_NAMES} from hit
union all
select ${STATUS_COLUMNS}
  from x_jobs
 where ${FENCE} and not exists (select 1 from hit)
`.trim();

export function pgTenantJobs(exec: () => PgExecutor): TenantJobs {
  return {
    async status(query) {
      const rows = await exec().query<JobStatusPgRow>(SQL_JOB_STATUS_FOR, [
        query.jobId,
        query.tenantId,
        query.name ?? null,
      ]);
      const row = rows[0];
      return row === undefined ? undefined : toJobStatusRow(row);
    },
    async cancel(query, reason) {
      const rows = await exec().query<JobStatusPgRow>(SQL_JOB_CANCEL_FOR, [
        query.jobId,
        query.tenantId,
        query.name ?? null,
        reason ?? null,
      ]);
      const row = rows[0];
      return row === undefined ? undefined : toJobStatusRow(row);
    },
  };
}
