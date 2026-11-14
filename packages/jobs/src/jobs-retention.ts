// Retention for FINISHED jobs: the `x_jobs` rows whose work is over, and the `x_job_steps` records
// under their runs, as one `PurgeTarget` the boot's hourly `purge()` sweeps. Until this existed
// nothing deleted a finished row, so the table grew by every job ever run — and a `mail.send` row's
// input is a recipient address and a rendered body, personal data kept for the life of the database.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { PurgeTarget } from './purge';
import { upkeepCadence } from './purge';
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
 * Each window is its OWN branch, seeking its own index in `updated_at` order and stopping at its
 * cutoff: one walk over all four states with a window per state stepped, every batch, over each
 * `dead` row inside its 90 days that sat between the `done` rows past their 14 — 32–40 ms a batch
 * in production. The two answers are merged, oldest first, to one batch; a row a branch locked
 * past the batch's `limit` is released at commit, untouched.
 *
 * `held` is a LATERAL probe with a `limit`, not an `exists`: the planner flattens an `exists` into
 * a semi-join and, at a 1,000-row batch, hashes the whole of `x_jobs` for it; the lateral form is one
 * `x_jobs_run_idx` lookup per deleted run (EXPLAIN, 63,000 rows, 2026-10-17).
 *
 * Each branch is a KEYSET walk, the claim's shape: it seeks from `$4` (done) / `$5` (ended), the
 * newest `updated_at` the previous batch deleted from it, answered back as `done_after` /
 * `ended_after`. A delete leaves its index entry until vacuum, and while any snapshot older than the
 * delete is open (a long transaction, a standby's feedback) no scan may skip that entry unread — so
 * a walk from the index's START stepped over every row the earlier batches deleted, a heap visit
 * each, and the last batch of a pass, or the first of the next, read most of the heap to delete
 * nothing (3,534 blocks, 47.6 ms, production 2026-11-14). `>=`, not `>`: rows that share the mark's
 * instant are re-read, never lost. Null starts at the index's first entry. A mark is ISO 8601 in UTC
 * to the microsecond, never `timestamptz::text`: that renders in the SESSION's DateStyle and zone,
 * and the next batch may run on a connection styled otherwise (`SQL, DMY` read as `MDY`). A range the planner
 * knows is small may be read as one bitmap scan: what it reads is then the batch itself.
 */
export const SQL_JOBS_RETENTION_BATCH = `
with done_rows as (
  select j.id, j.run_id, j.updated_at, true as done from x_jobs j
   where j.state = 'done'
     and j.updated_at >= coalesce($4::timestamptz, '-infinity'::timestamptz)
     and j.updated_at < statement_timestamp() - ($1::bigint * interval '1 millisecond')
     and not exists (select 1 from x_outbox o where o.id = j.id and o.published_at is null)
     and not exists (select 1 from x_backfills b where b.run_id = j.run_id and b.status = 'running')
   order by j.updated_at
   limit $3
     for update of j skip locked
), ended_rows as (
  select j.id, j.run_id, j.updated_at, false as done from x_jobs j
   where j.state in ('failed', 'dead', 'cancelled')
     and j.updated_at >= coalesce($5::timestamptz, '-infinity'::timestamptz)
     and j.updated_at < statement_timestamp() - ($2::bigint * interval '1 millisecond')
     and not exists (select 1 from x_outbox o where o.id = j.id and o.published_at is null)
     and not exists (select 1 from x_backfills b where b.run_id = j.run_id and b.status = 'running')
   order by j.updated_at
   limit $3
     for update of j skip locked
), doomed as (
  select id, run_id, updated_at, done
    from (select * from done_rows union all select * from ended_rows) d
   order by updated_at
   limit $3
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
       (select coalesce(json_agg(run_id), '[]'::json) from held)::text as held,
       to_char((select max(updated_at) from doomed where done) at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as done_after,
       to_char((select max(updated_at) from doomed where not done) at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ended_after
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
 * Step records whose run has NO `x_jobs` row left — what the follow-up above would have removed had
 * its process lived to send it. A sweep that commits a batch and dies before the follow-up strands
 * a held run's steps, and no later batch names that run again: this is the pass that does. Once
 * per pass, after the batches, at most `$2` records.
 *
 * Only records started before the shorter window (`$1`): a job is deleted no sooner than that after
 * its last settle, and every step of it started before that settle, so a true orphan always
 * qualifies — and a record younger than the window belongs to a run whose row cannot have been
 * swept yet. Each candidate is one `x_jobs_run_idx` probe, a LATERAL with a `limit` for the reason
 * `held` is one: as `not exists` the planner hashes the whole of `x_jobs` for a few thousand
 * candidates (EXPLAIN, 2026-10-17), a cost that grows with the queue rather than with the old step
 * records. The delete is the `x_job_steps` primary key. `skip locked` for the reason the batch gives.
 *
 * Once a DAY (`PURGE_UPKEEP_EVERY_MS`), not once a pass: `started_at` has no index, so this is a scan
 * of every step record (66,769 in production, growing), and what it repairs is rare. No index for
 * it either: `x_job_steps` takes a write per step, and a btree would tax each for a daily read.
 */
export const SQL_JOBS_RETENTION_ORPHANS = `
with orphaned as (
  select s.run_id, s.name from x_job_steps s
    left join lateral (
      select 1 as standing from x_jobs j where j.run_id = s.run_id limit 1
    ) l on true
   where s.started_at < statement_timestamp() - ($1::bigint * interval '1 millisecond')
     and l.standing is null
   limit $2
     for update of s skip locked
), gone as (
  delete from x_job_steps s using orphaned o
   where s.run_id = o.run_id and s.name = o.name
  returning 1
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

/** Where each branch's next batch seeks from: the newest `updated_at` it deleted, as text. */
interface RetentionMarks {
  done: string | null;
  ended: string | null;
}

interface BatchRow {
  readonly removed: number | string;
  readonly held: string | null;
  readonly done_after: string | null;
  readonly ended_after: string | null;
}

/** `x_jobs` as a purge target, batched (`purge-batches.ts`). */
export function jobsPurgeTarget(options: JobsRetentionOptions): PurgeTarget {
  const done = finiteCount(SUBJECT, 'doneRetentionMs', options.doneRetentionMs, 1);
  const dead = finiteCount(SUBJECT, 'deadRetentionMs', options.deadRetentionMs, 1);
  const bounds = purgeBatching(SUBJECT, options);
  const upkeepDue = upkeepCadence();
  // Kept across passes, so the next hour does not re-walk this one's deletes either. Below a mark
  // stand only rows a batch skipped — locked, or vetoed by the outbox or a backfill — and the
  // daily upkeep forgets the marks so those get their turn: a day late at worst, never lost.
  const marks: RetentionMarks = { done: null, ended: null };
  return {
    name: 'x_jobs',
    // The count is `x_jobs` rows, the target's name; orphaned step records are its upkeep.
    purgeExpired: async (nowMs): Promise<number> => {
      const upkeep = upkeepDue(nowMs);
      if (upkeep) {
        marks.done = null;
        marks.ended = null;
      }
      const removed = await purgeInBatches(jobsBatch(options.executor, done, dead, marks), bounds);
      if (upkeep) {
        await options.executor.query(SQL_JOBS_RETENTION_ORPHANS, [
          Math.min(done, dead),
          bounds.batch,
        ]);
      }
      return removed;
    },
  };
}

/**
 * One batch of `SQL_JOBS_RETENTION_BATCH` from `marks`, moving them on; then the held runs' steps
 * if it answered any. A branch that deleted nothing keeps its mark.
 */
function jobsBatch(
  executor: PgExecutor,
  done: number,
  dead: number,
  marks: RetentionMarks,
): PurgeBatch {
  return async (size) => {
    const rows = await executor.query<BatchRow>(SQL_JOBS_RETENTION_BATCH, [
      done,
      dead,
      size,
      marks.done,
      marks.ended,
    ]);
    const row = rows[0];
    marks.done = row?.done_after ?? marks.done;
    marks.ended = row?.ended_after ?? marks.ended;
    const held = row?.held ?? '[]';
    if (held !== '[]') await executor.query(SQL_JOBS_RETENTION_STEPS, [held]);
    return Number(row?.removed ?? 0);
  };
}
