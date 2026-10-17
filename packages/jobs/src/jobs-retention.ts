// Retention for FINISHED jobs: the `x_jobs` rows whose work is over, and the `x_job_steps` records
// under their runs, as one `PurgeTarget` the boot's hourly `purge()` sweeps. Until this existed
// nothing deleted a finished row, so the table grew by every job ever run — and a `mail.send` row's
// input is a recipient address and a rendered body, personal data kept for the life of the database.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { PurgeTarget } from './purge';
import {
  type PurgeBatch,
  type PurgeBatching,
  purgeBatching,
  purgeInBatches,
} from './purge-batches';

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
 * operator holding a row.
 *
 * A run's step records go in the same statement when no row outside this batch shares the run.
 * When one does (`held`), they stay and the run is answered: that row may be another sweep's,
 * deleted but not yet committed — invisible as gone to this snapshot, just as this batch's rows are
 * to that one — so each statement alone would keep the steps forever. `SQL_JOBS_RETENTION_STEPS`
 * settles a held run after this commits.
 *
 * `held` is a LATERAL probe with a `limit`, not an `exists`: the planner flattens an `exists` into
 * a semi-join and, at a 1,000-row batch, hashes the whole of `x_jobs` for it; the lateral form is one
 * `x_jobs_run_idx` lookup per deleted run (EXPLAIN, 63,000 rows, 2026-10-17).
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
), held as (
  select g.run_id from (select distinct run_id from gone) g
   cross join lateral (
     select 1 from x_jobs l
      where l.run_id = g.run_id and l.id not in (select id from doomed)
      limit 1
   ) standing
), steps as (
  delete from x_job_steps s
   where s.run_id in (select run_id from gone)
     and s.run_id not in (select run_id from held)
)
select (select count(*) from gone)::int as removed,
       (select coalesce(json_agg(run_id), '[]'::json) from held)::text as held
`.trim();

/**
 * The held runs' step records, in a statement of its own — so its snapshot is taken AFTER the batch
 * that answered them committed. Of two sweeps that each deleted one row of a shared run, the one
 * whose follow-up starts last sees both deletes, and removes the steps. A run with a row still
 * standing (a retry, a younger terminal row) keeps them, for the sweep that takes that row.
 * The ids travel as JSON text, never a bound array (issue #384).
 */
export const SQL_JOBS_RETENTION_STEPS = `
delete from x_job_steps s
 where s.run_id in (select value::uuid from json_array_elements_text($1::json))
   and not exists (select 1 from x_jobs j where j.run_id = s.run_id)
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
      purgeInBatches(jobsBatch(options.executor, done, dead), bounds),
  };
}

/** One batch of `SQL_JOBS_RETENTION_BATCH`, then the held runs' steps if it answered any. */
function jobsBatch(executor: PgExecutor, done: number, dead: number): PurgeBatch {
  return async (size) => {
    const rows = await executor.query<{ removed: number | string; held: string | null }>(
      SQL_JOBS_RETENTION_BATCH,
      [done, dead, size],
    );
    const held = rows[0]?.held ?? '[]';
    if (held !== '[]') await executor.query(SQL_JOBS_RETENTION_STEPS, [held]);
    return Number(rows[0]?.removed ?? 0);
  };
}
