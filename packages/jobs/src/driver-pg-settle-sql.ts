// The two statements that SETTLE a claimed row, and `SQL_COUNTER_FLUSH`, which writes a process's
// batched counts (`counter-batch.ts`): a per-settle counter upsert was the largest WAL writer at
// idle-ish load, so a settle no longer carries one. Split off `driver-pg-sql.ts` at its size
// ceiling; the settles are re-exported from it.

/**
 * `and state = 'running'`, `and claimed_by = $2` and `and claims = $3` are all FENCES, not
 * filters. Without the first, an ack from a worker that was cancelled overwrites the
 * cancellation. Without the second, an ack from a worker whose lease lapsed marks `done` a run
 * ANOTHER worker has since claimed and is still executing — the row is `running` again, so the
 * state fence alone lets it through. Without the third, the same thing happens when the worker
 * that claimed it again is the SAME one: its id did not change, only the claim's ordinal did.
 * `returning name` is how the caller learns whether its settle landed, and what to count.
 *
 * $1 id, $2 worker, $3 the claim.
 */
export const SQL_ACK = `
update x_jobs
   set state = 'done', visible_at = null, claimed_by = null, updated_at = now()
 where id = $1 and state = 'running' and claimed_by = $2 and claims = $3::int
returning name
`.trim();

/**
 * The same three fences. The caller counts only a settle `nackOutcome` names: a shed, a
 * suspension and a drained attempt are handed back UNCOUNTED and are not history.
 *
 * $1 id, $2 state, $3 counts-as-attempt, $4 delay ms, $5 error, $6 worker, $7 stack, $8 the claim.
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
       updated_at = now()
 where id = $1 and state = 'running' and claimed_by = $6 and claims = $8::int
returning name
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
