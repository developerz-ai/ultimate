// Retention for FINISHED jobs: the `x_jobs` rows whose work is over, and the `x_job_steps` records
// under their runs, as one `PurgeTarget` the boot's hourly `purge()` sweeps. Until this existed
// nothing deleted a finished row, so the table grew by every job ever run — and a `mail.send` row's
// input is a recipient address and a rendered body, personal data kept for the life of the database.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { PurgeTarget } from './purge';
import { type PurgeBatching, purgeBatching, purgeInBatches } from './purge-batches';

/**
 * One batch, counted in the statement (`PgExecutor` answers rows, never a command tag).
 *
 * Aged by `updated_at`, which every settle stamps with the server's `now()` — so the cutoff is the
 * server's clock too, and the job's `nowMs` is not read: measuring a server-written instant against
 * a caller's clock is the two-clock mismatch `PurgeTarget.purgeExpired` warns about.
 *
 * Only the four TERMINAL states, never a live one (`LIVE_STATES`). Two vetoes on top, each a row
 * that still names the job as unfinished work: an `x_outbox` row not yet published under this id
 * (deleting the job would let the relay insert it again, a second run) and an `x_backfills` ledger
 * row still `running` under this run. `skip locked` so a sweep never waits on a worker or an
 * operator holding a row, and a step record goes only when no surviving row shares its run.
 */
export const SQL_JOBS_RETENTION_BATCH = `
with doomed as (
  select j.id, j.run_id from x_jobs j
   where ((j.state = 'done'
           and j.updated_at < statement_timestamp() - ($1::bigint * interval '1 millisecond'))
       or (j.state in ('failed', 'dead', 'cancelled')
           and j.updated_at < statement_timestamp() - ($2::bigint * interval '1 millisecond')))
     and not exists (select 1 from x_outbox o where o.id = j.id and o.published_at is null)
     and not exists (select 1 from x_backfills b where b.run_id = j.run_id and b.status = 'running')
   order by j.updated_at
   limit $3
     for update of j skip locked
), gone as (
  delete from x_jobs where id in (select id from doomed) returning run_id
), steps as (
  delete from x_job_steps s
   where s.run_id in (select run_id from gone)
     and not exists (
       select 1 from x_jobs l where l.run_id = s.run_id and l.id not in (select id from doomed)
     )
)
select count(*)::int as removed from gone
`.trim();

/**
 * The two windows are REQUIRED here: their defaults are `app.config.ts`'s (`jobs.doneRetentionMs`,
 * `jobs.deadRetentionMs`, in `@ultimat3/core`), and a second default in this file would be a second
 * answer to "how long is a finished job kept".
 */
export interface JobsRetentionOptions extends PurgeBatching {
  readonly executor: PgExecutor;
  /** Age past which a `done` row goes. */
  readonly doneRetentionMs: number;
  /** Age past which a `dead`, `failed` or `cancelled` row goes. */
  readonly deadRetentionMs: number;
}

const SUBJECT = 'jobsPurgeTarget';

/** `x_jobs` as a purge target, batched (`purge-batches.ts`). */
export function jobsPurgeTarget(options: JobsRetentionOptions): PurgeTarget {
  const done = finiteCount(SUBJECT, 'doneRetentionMs', options.doneRetentionMs, 1);
  const dead = finiteCount(SUBJECT, 'deadRetentionMs', options.deadRetentionMs, 1);
  const bounds = purgeBatching(SUBJECT, options);
  return {
    name: 'x_jobs',
    purgeExpired: (): Promise<number> =>
      purgeInBatches(options.executor, SQL_JOBS_RETENTION_BATCH, [done, dead], bounds),
  };
}
