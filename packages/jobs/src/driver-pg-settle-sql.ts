// The two statements that SETTLE a claimed row, each also adding the settle to its job's
// one-minute counter bucket. One statement, not two: a count that can disagree with the rows is
// worse than no count, and a second round trip per job is a cost every job would pay. Split off
// `driver-pg-sql.ts` at its size ceiling and re-exported from it.

import { COUNTER_BUCKET_MS } from './introspection';

/** `x_job_counters`'s conflict target and the bucket every settle writes — spelled once. */
const BUCKET = `${COUNTER_BUCKET_MS}, date_trunc('minute', now())`;

/**
 * `and state = 'running'`, `and claimed_by = $2` and `and claims = $4` are all FENCES, not
 * filters. Without the first, an ack from a worker that was cancelled overwrites the
 * cancellation. Without the second, an ack from a worker whose lease lapsed marks `done` a run
 * ANOTHER worker has since claimed and is still executing — the row is `running` again, so the
 * state fence alone lets it through. Without the third, the same thing happens when the worker
 * that claimed it again is the SAME one: its id did not change, only the claim's ordinal did.
 * `returning` is how the caller learns whether its settle landed.
 *
 * $1 id, $2 worker, $3 the attempt's duration in ms, $4 the claim.
 */
export const SQL_ACK = `
with settled as (
  update x_jobs
     set state = 'done', visible_at = null, claimed_by = null, updated_at = now()
   where id = $1 and state = 'running' and claimed_by = $2 and claims = $4::int
  returning name
), counted as (
  insert into x_job_counters (job, bucket_ms, bucket_start, done, duration_ms)
  select name, ${BUCKET}, 1, $3::bigint from settled
  on conflict (job, bucket_ms, bucket_start) do update
     set done        = x_job_counters.done + 1,
         duration_ms = x_job_counters.duration_ms + excluded.duration_ms
)
select name from settled
`.trim();

/**
 * The same three fences. The counter row is written only when one of the three counts is set: a
 * shed, a suspension and a drained attempt are handed back UNCOUNTED and are not history.
 *
 * $1 id, $2 state, $3 counts-as-attempt, $4 delay ms, $5 error, $6 worker, $7 stack,
 * $8 retried, $9 failed, $10 dead (each 0 or 1), $11 the attempt's duration in ms, $12 the claim.
 */
export const SQL_NACK = `
with settled as (
  update x_jobs
     set state      = $2,
         attempt    = case when $3::boolean then attempt else greatest(attempt - 1, 0) end,
         run_at     = now() + ($4::bigint * interval '1 millisecond'),
         visible_at = null,
         claimed_by = null,
         last_error = coalesce($5::text, last_error),
         last_error_stack = case when $5::text is null then last_error_stack else $7::text end,
         updated_at = now()
   where id = $1 and state = 'running' and claimed_by = $6 and claims = $12::int
  returning name
), counted as (
  insert into x_job_counters (job, bucket_ms, bucket_start, retried, failed, dead, duration_ms)
  select name, ${BUCKET}, $8::int, $9::int, $10::int, $11::bigint
    from settled
   where $8::int + $9::int + $10::int > 0
  on conflict (job, bucket_ms, bucket_start) do update
     set retried     = x_job_counters.retried + excluded.retried,
         failed      = x_job_counters.failed + excluded.failed,
         dead        = x_job_counters.dead + excluded.dead,
         duration_ms = x_job_counters.duration_ms + excluded.duration_ms
)
select name from settled
`.trim();
