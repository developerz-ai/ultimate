// The publish that wakes its waiters: one statement inserts the event, makes every run parked on
// it due, and tells each of their queues. One statement, so a rollback undoes all three, and the
// NOTIFY is delivered at commit only. What `postgresEventBus({ wakes: true })` runs.

import { JOBS_WAKE_CHANNEL } from './driver-pg-wake-sql';

/**
 * `SQL_EVENT_PUBLISH`, plus the wake. A waiter is a `waiting` step on this event whose key is this
 * event's or absent — `SQL_EVENT_FIND`'s match, read from the step's side — over the partial
 * `x_job_steps_waiting_idx`, so a publish with no waiter reads no step at all.
 *
 * Woken means `run_at` moved to now on a `suspended` row that was not already due: a running row,
 * a finished one, or one a concurrent publish already woke (the row lock re-checks `run_at` after
 * the first commit) is left alone. The poll stays the guarantee; this only brings it forward.
 *
 * One `pg_notify` per DISTINCT queue of the woken rows, and none when nothing woke: never
 * unconditional, for the commit lock `driver-pg-wake-sql.ts` describes. The payload is the queue.
 *
 * $1 id, $2 name, $3 payload, $4 correlation key, $5 ttl (ms).
 */
export const SQL_EVENT_PUBLISH_WAKE = `
with ev as (
  insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
  values ($1, $2, $3::jsonb, $4, statement_timestamp(),
          statement_timestamp() + ($5::bigint * interval '1 millisecond'))
  returning published_at, expires_at
), waiters as (
  select distinct s.run_id
    from x_job_steps s
   where s.status = 'waiting'
     and s.event = $2
     and (s.correlation_key is null or s.correlation_key = $4::text)
), woken as (
  update x_jobs j
     set run_at     = statement_timestamp(),
         updated_at = statement_timestamp()
    from waiters w
   where j.run_id = w.run_id
     and j.state = 'suspended'
     and j.run_at > statement_timestamp()
  returning j.queue
), told as (
  select count(pg_notify('${JOBS_WAKE_CHANNEL}', q.queue))::int as told
    from (select distinct queue from woken) q
)
select floor(extract(epoch from ev.published_at) * 1000)::bigint as published_at,
       floor(extract(epoch from ev.expires_at)   * 1000)::bigint as expires_at,
       (select count(*) from woken)::int as woken,
       (select told from told) as told
  from ev
`.trim();
