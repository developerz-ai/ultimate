// The two statements that SETTLE a claimed row, the `onSettled` debt they record (J11), and
// `SQL_COUNTER_FLUSH`, which writes a process's batched counts (`counter-batch.ts`): a per-settle
// counter upsert was the largest WAL writer at idle-ish load, so a settle no longer carries one.
// Split off `driver-pg-sql.ts` at its size ceiling; the settles are re-exported from it.

import { JOB_ROW_COLUMNS } from './driver-pg-jobs-sql';

/**
 * `and state = 'running'`, `and claimed_by = $2` and `and claims = $3` are all FENCES, not
 * filters. Without the first, an ack from a worker that was cancelled overwrites the
 * cancellation. Without the second, an ack from a worker whose lease lapsed marks `done` a run
 * ANOTHER worker has since claimed and is still executing — the row is `running` again, so the
 * state fence alone lets it through. Without the third, the same thing happens when the worker
 * that claimed it again is the SAME one: its id did not change, only the claim's ordinal did.
 * `returning name` is how the caller learns whether its settle landed, and what to count.
 *
 * `settle_owed` is the hook's debt, recorded in the same write: there is no instant at which the
 * row is `done` and nothing says its `onSettled` is still owed.
 *
 * $1 id, $2 worker, $3 the claim, $4 the job declares `onSettled`.
 */
export const SQL_ACK = `
update x_jobs
   set state = 'done', visible_at = null, claimed_by = null, updated_at = now(),
       settle_owed = $4::boolean
 where id = $1 and state = 'running' and claimed_by = $2 and claims = $3::int
returning name
`.trim();

/**
 * The same three fences. The caller counts only a settle `nackOutcome` names: a shed, a
 * suspension and a drained attempt are handed back UNCOUNTED and are not history.
 *
 * The hook is owed only by a nack that ENDS the run: a retry, a suspension and a shed owe nothing.
 *
 * $1 id, $2 state, $3 counts-as-attempt, $4 delay ms, $5 error, $6 worker, $7 stack, $8 the claim,
 * $9 the job declares `onSettled`.
 */
export const SQL_NACK = `
update x_jobs
   set state      = $2,
       attempt    = case when $3::boolean then attempt else greatest(attempt - 1, 0) end,
       run_at     = now() + ($4::bigint * interval '1 millisecond'),
       visible_at = null,
       claimed_by = null,
       last_error = coalesce($5::text, last_error),
       last_error_stack = case when $5::text is null then last_error_stack else $7::text end,
       updated_at = now(),
       settle_owed = $9::boolean and $2::text in ('dead', 'failed')
 where id = $1 and state = 'running' and claimed_by = $6 and claims = $8::int
returning name
`.trim();

/**
 * The hook of one settlement returned: its debt is paid. Fenced on the claim the settle was made
 * under, so a row requeued and settled again since is that NEW settlement's debt, left standing.
 * `updated_at` is not touched: it is the row's end, which retention reads.
 *
 * $1 id, $2 the claim.
 */
export const SQL_SETTLE_CLEAR = `
update x_jobs set settle_owed = false
 where id = $1 and settle_owed and claims = $2::int
returning id
`.trim();

/**
 * The debts a crash left: ended rows of a hooked job owed longer than that job's grace, oldest
 * first, `skip locked` so two leaders never take one. TAKEN by restarting `updated_at`, the clock
 * the grace is read from: a pass inside the grace finds them owed and too young. A row requeued
 * since is live again and owes nothing until it ends — the state list is the fence.
 *
 * $1 `[{ name, graceMs }]` as JSON, $2 the limit.
 */
export const SQL_SETTLE_TAKE_LOST = `
with lost as (
  select j.id as lost_id
    from x_jobs j
    join jsonb_to_recordset($1::jsonb) as r(name text, "graceMs" bigint) on r.name = j.name
   where j.settle_owed
     and j.state in ('done', 'dead', 'failed')
     and j.updated_at <= now() - (r."graceMs" * interval '1 millisecond')
   order by j.updated_at
   limit $2::int
   for update of j skip locked
)
update x_jobs set updated_at = now()
  from lost
 where x_jobs.id = lost.lost_id
returning ${JOB_ROW_COLUMNS}
`.trim();

/**
 * A process's batched counts (`counter-batch.ts`), every row in one statement. The bucket is the
 * PROCESS's minute, as the memory driver's is: a settle is counted where its clock put it. Rows
 * arrive unique and ordered by (job, bucket), so two flushers take their row locks in one order.
 *
 * $1 the bucket width, $2 `[{ job, startMs, done, retried, failed, dead, durationMs }]` as JSON.
 */
export const SQL_COUNTER_FLUSH = `
insert into x_job_counters
  (job, bucket_ms, bucket_start, done, retried, failed, dead, duration_ms)
select r.job, $1::int, to_timestamp(r."startMs" / 1000.0), r.done, r.retried, r.failed, r.dead,
       r."durationMs"
  from jsonb_to_recordset($2::jsonb)
    as r(job text, "startMs" bigint, done bigint, retried bigint, failed bigint, dead bigint,
         "durationMs" bigint)
on conflict (job, bucket_ms, bucket_start) do update
   set done        = x_job_counters.done + excluded.done,
       retried     = x_job_counters.retried + excluded.retried,
       failed      = x_job_counters.failed + excluded.failed,
       dead        = x_job_counters.dead + excluded.dead,
       duration_ms = x_job_counters.duration_ms + excluded.duration_ms
`.trim();
