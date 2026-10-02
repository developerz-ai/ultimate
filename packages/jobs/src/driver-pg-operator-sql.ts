// Every statement behind the operator surface (`introspection.ts`) and the scheduler's atomic
// fire. One decision per statement throughout: a bulk call, a fold and a fire each read and write
// in ONE round trip, so nothing here counts rows and then acts on the count.
//
// Text is ordered `collate "C"` wherever a list is ordered by name: the memory driver compares by
// code unit, and a database collation would order the same names differently.

import { JOB_ROW_COLUMNS } from './driver-pg-jobs-sql';
import { JOBS_WAKE_CHANNEL } from './driver-pg-wake-sql';

const LIVE = `('ready', 'delayed', 'running', 'suspended')`;

/** $1 state, $2 queue, $3 name, $5 tenant — the predicates every bulk statement shares. */
const bulkMatch = (alias = ''): string =>
  `${alias}state = $1 and ($2::text is null or ${alias}queue = $2) and ($3::text is null or ${alias}name = $3) and ($5::text is null or ${alias}tenant_id = $5)`;

/**
 * Re-queue up to $4 finished rows. `eligible` is every row of the filter no LIVE job holds the key
 * of — the single requeue's `X_JOB_DUPLICATE`, answered here as "not this row" — and `distinct on`
 * the idempotency namespace picks one of them per key, because two dead rows of one key would both
 * go `ready` and the second would break the live index.
 *
 * `remaining` is what a second call could still move, counted in the same statement off the same
 * snapshot: the eligible rows whose key this call did not just take. A held row was counted too,
 * so a caller told to "call again until it is zero" never stopped.
 */
export const SQL_JOB_REQUEUE_MANY = `
with eligible as (
  select j.id, j.name, coalesce(j.tenant_id, '') as tenant, j.idempotency_key, j.created_at
    from x_jobs j
   where ${bulkMatch('j.')}
     and not exists (
       select 1 from x_jobs l
        where l.name = j.name
          and coalesce(l.tenant_id, '') = coalesce(j.tenant_id, '')
          and l.idempotency_key = j.idempotency_key
          and l.state in ${LIVE}
     )
), candidates as (
  select distinct on (name, tenant, idempotency_key) id, name, tenant, idempotency_key
    from eligible
   order by name, tenant, idempotency_key, created_at
   limit $4
), moved as (
  update x_jobs
     set state = 'ready', attempt = 0, run_at = now(), updated_at = now(),
         claimed_by = null, visible_at = null
   where id in (select id from candidates) and state = $1
  returning id
)
select (select count(*) from moved)::int as affected,
       (select count(*) from eligible e
         where not exists (
           select 1 from candidates c
             join moved m on m.id = c.id
            where c.name = e.name and c.tenant = e.tenant
              and c.idempotency_key = e.idempotency_key
         ))::int as remaining
`.trim();

/** Delete up to $4 rows and their step records. `running` is refused before this is sent. */
export const SQL_JOB_REMOVE_MANY = `
with doomed as (
  select id, run_id from x_jobs
   where ${bulkMatch()} and state <> 'running'
   order by created_at
   limit $4
     for update skip locked
), steps as (
  delete from x_job_steps where run_id in (select run_id from doomed)
), gone as (
  delete from x_jobs where id in (select id from doomed) returning id
)
select (select count(*) from gone)::int as affected,
       (select count(*) from x_jobs where ${bulkMatch()})::int as matching
`.trim();

/**
 * Up to $4 rows of the filter still waiting on `run_at`, due now — `SQL_JOB_PROMOTE` over a set.
 * `remaining` counts the rows of the filter STILL waiting afterwards: a `ready` row already due has
 * nothing to promote, so it is neither affected nor remaining. `woke` announces the queues it made
 * claimable, once each (`driver-pg-wake-sql.ts`).
 */
export const SQL_JOB_PROMOTE_MANY = `
with due as (
  select id from x_jobs
   where ${bulkMatch()} and run_at > now()
   order by created_at
   limit $4
     for update skip locked
), moved as (
  update x_jobs
     set state = 'ready', run_at = now(), updated_at = now()
   where id in (select id from due) and run_at > now()
  returning id, queue
), woke as (
  select pg_notify('${JOBS_WAKE_CHANNEL}', queue) from (select distinct queue from moved) q
)
select (select count(*) from moved)::int as affected,
       (select count(*) from woke)::int as woken,
       (select count(*) from x_jobs where ${bulkMatch()} and run_at > now()
          and id not in (select id from moved))::int as matching
`.trim();

/** One row and its steps. Fenced on not-running, so a claim that raced the delete wins. */
export const SQL_JOB_REMOVE = `
with gone as (
  delete from x_jobs where id = $1 and state <> 'running' returning run_id
), steps as (
  delete from x_job_steps where run_id in (select run_id from gone)
)
select run_id from gone
`.trim();

/**
 * Due now. Only a row waiting on its `run_at` — delayed at enqueue, or `ready` and backing off —
 * and never a `suspended` one, whose wake time is its step record and not this column. `woke`
 * announces the row in the statement that made it due (`driver-pg-wake-sql.ts`).
 */
export const SQL_JOB_PROMOTE = `
update x_jobs
   set state = 'ready', run_at = now(), updated_at = now()
 where id = $1 and state in ('ready', 'delayed') and run_at > now()
returning ${JOB_ROW_COLUMNS},
          pg_notify('${JOBS_WAKE_CHANNEL}', queue)::text as woke
`.trim();

/** Fenced on the claim, as both settles are. $1 id, $2 worker, $3 the progress value, $4 claim. */
export const SQL_JOB_PROGRESS = `
update x_jobs set progress = $3::jsonb
 where id = $1 and state = 'running' and claimed_by = $2 and claims = $4::int
`.trim();

/** The FIRST pause is the one recorded: pausing a paused queue does not move `paused_at`. */
export const SQL_PAUSE = `
insert into x_job_pauses (kind, name) values ($1, $2)
on conflict (kind, name) do nothing
`.trim();

export const SQL_RESUME = `
delete from x_job_pauses where kind = $1 and name = $2
`.trim();

export const SQL_PAUSED = `
select name, (extract(epoch from paused_at) * 1000)::bigint as paused_at
  from x_job_pauses where kind = $1 order by name collate "C"
`.trim();

/**
 * A worker's heartbeat: the whole row rewritten, expiry pushed out. $1 id, $2 host, $3 queues,
 * $4 slots, $5 in-flight ids, $6 started (ms), $7 ttl (ms).
 */
export const SQL_WORKER_ANNOUNCE = `
insert into x_job_workers
  (id, host, queues, concurrency, in_flight, started_at, heartbeat_at, expires_at)
values
  ($1, $2, $3::jsonb, $4::int, $5::jsonb, to_timestamp($6::bigint / 1000.0), now(),
   now() + ($7::bigint * interval '1 millisecond'))
on conflict (id) do update
   set host = excluded.host, queues = excluded.queues, concurrency = excluded.concurrency,
       in_flight = excluded.in_flight, heartbeat_at = excluded.heartbeat_at,
       expires_at = excluded.expires_at
`.trim();

export const SQL_WORKER_FORGET = `
delete from x_job_workers where id = $1
`.trim();

/**
 * Live rows only, and the lapsed ones go in the same statement: a killed worker is never read
 * again, and nothing else has to be running for its row to leave.
 */
export const SQL_WORKERS = `
with lapsed as (
  delete from x_job_workers where expires_at <= now()
)
select id, host, queues, concurrency, in_flight,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from heartbeat_at) * 1000)::bigint as heartbeat_at
  from x_job_workers
 where expires_at > now()
 order by started_at, id
`.trim();

const COUNTER_COLUMNS = `done, retried, failed, dead, duration_ms`;

export const SQL_COUNTERS = `
select job, bucket_ms, (extract(epoch from bucket_start) * 1000)::bigint as bucket_start,
       ${COUNTER_COLUMNS}
  from x_job_counters
 where job = $1 and bucket_start >= to_timestamp($2::bigint / 1000.0)
 order by bucket_start, bucket_ms
`.trim();

export const SQL_COUNTER_TOTALS = `
select job, sum(done)::bigint as done, sum(retried)::bigint as retried,
       sum(failed)::bigint as failed, sum(dead)::bigint as dead,
       sum(duration_ms)::bigint as duration_ms
  from x_job_counters
 where bucket_start >= to_timestamp($1::bigint / 1000.0)
 group by job
 order by job collate "C"
`.trim();

/**
 * Fold every bucket of width $1 older than $2 ms into the bucket of width $3 that contains it.
 * Delete-and-insert in one statement, so a fold that two nodes run at once moves each bucket
 * once: the second node's `delete` finds the rows gone.
 */
export const SQL_COUNTER_FOLD = `
with old as (
  delete from x_job_counters
   where bucket_ms = $1::int and bucket_start < now() - ($2::bigint * interval '1 millisecond')
  returning job, bucket_start, ${COUNTER_COLUMNS}
), folded as (
  insert into x_job_counters (job, bucket_ms, bucket_start, ${COUNTER_COLUMNS})
  select job, $3::int,
         to_timestamp(floor(extract(epoch from bucket_start) * 1000 / $3::int) * $3::int / 1000.0),
         sum(done), sum(retried), sum(failed), sum(dead), sum(duration_ms)
    from old
   group by 1, 3
  on conflict (job, bucket_ms, bucket_start) do update
     set done        = x_job_counters.done + excluded.done,
         retried     = x_job_counters.retried + excluded.retried,
         failed      = x_job_counters.failed + excluded.failed,
         dead        = x_job_counters.dead + excluded.dead,
         duration_ms = x_job_counters.duration_ms + excluded.duration_ms
)
select count(*)::int as moved from old
`.trim();

/** The last tier has nowhere to fold into: past its `keepMs` a bucket is dropped. */
export const SQL_COUNTER_DROP = `
with old as (
  delete from x_job_counters
   where bucket_ms = $1::int and bucket_start < now() - ($2::bigint * interval '1 millisecond')
  returning job
)
select count(*)::int as moved from old
`.trim();

/**
 * The record of a fire that went through `driver.enqueue` — a store that could not write it in
 * the firing statement. The watermark only ever moves forward here too. $1 task, $2 occurrence.
 */
export const SQL_TASK_FIRE_RECORD = `
insert into x_scheduler_state
  (task_name, last_fired_at, updated_at, fired_occurrence_at, fired_at)
values ($1, to_timestamp($2::bigint / 1000.0), now(), to_timestamp($2::bigint / 1000.0), now())
on conflict (task_name) do update
   set last_fired_at = greatest(x_scheduler_state.last_fired_at, excluded.last_fired_at),
       updated_at = now(),
       fired_occurrence_at = excluded.fired_occurrence_at, fired_at = excluded.fired_at
`.trim();

/** Every task that has dispatched. A row that was only ever armed has no `fired_at`. $1 limit. */
export const SQL_TASK_FIRES = `
select task_name,
       (extract(epoch from fired_occurrence_at) * 1000)::bigint as occurrence,
       (extract(epoch from fired_at) * 1000)::bigint as fired_at
  from x_scheduler_state
 where fired_at is not null
 order by task_name collate "C"
 limit $1
`.trim();

/**
 * One occurrence, fired ATOMICALLY: the watermark moves onto it and its jobs are queued in one
 * statement, or neither happens.
 *
 * It was two round trips — enqueue each job, then mark — and anything between them (a rejected
 * mark, a dead process, job 2 of 3 failing) left the watermark behind the jobs already queued. The
 * next round fired the occurrence again, and the occurrence-scoped idempotency key only absorbs
 * that while the first job is still LIVE: the unique index is partial, so once job 1 is `done` the
 * repeat inserts a second row and the work runs twice.
 *
 * The watermark is the fence. `moved` is empty when it is already at or past this occurrence —
 * another dispatcher fired it — and `queued` inserts only `where exists (select 1 from moved)`.
 * `woken` announces each queue that received a job, once, when the statement commits — read in
 * the final select because a plain-select CTE nothing reads is never run.
 *
 * The fence is the OCCURRENCE and the watermark may land past it: `run-once` runs the earliest
 * missed occurrence and drops the rest, and dropping is the watermark moving beyond them. That was
 * a second statement behind this one, and a crash between the two fired a second "one catch-up".
 * `greatest` ignores a null, so with no `$4` the watermark lands on the occurrence — and a `$4`
 * behind the occurrence can never leave the watermark short of what just fired.
 *
 * $1 task, $2 occurrence (ms), $3 the jobs as a JSON array, $4 where the watermark lands (ms) or
 * null for the occurrence itself.
 */
export const SQL_SCHEDULER_FIRE = `
with moved as (
  insert into x_scheduler_state
    (task_name, last_fired_at, updated_at, fired_occurrence_at, fired_at)
  values ($1, to_timestamp(greatest($2::bigint, $4::bigint) / 1000.0), now(),
          to_timestamp($2::bigint / 1000.0), now())
  on conflict (task_name) do update
     set last_fired_at = excluded.last_fired_at, updated_at = now(),
         fired_occurrence_at = excluded.fired_occurrence_at, fired_at = excluded.fired_at
   where x_scheduler_state.last_fired_at < excluded.fired_occurrence_at
  returning task_name
), queued as (
  insert into x_jobs
    (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at)
  select j.id, j.name, j.queue, coalesce(j.input, 'null'::jsonb), j.idempotency_key, j.run_id, j.max_attempts,
         case when to_timestamp($2::bigint / 1000.0) > now() then 'delayed' else 'ready' end,
         to_timestamp($2::bigint / 1000.0)
    from jsonb_to_recordset($3::jsonb) as j(
           id uuid, name text, queue text, input jsonb, idempotency_key text,
           run_id uuid, max_attempts int)
   where exists (select 1 from moved)
  on conflict (name, (coalesce(tenant_id, '')), idempotency_key)
    where state in ${LIVE}
    do nothing
  returning id, run_id, idempotency_key, queue
), woken as (
  select pg_notify('${JOBS_WAKE_CHANNEL}', w.queue) from (select distinct queue from queued) w
)
select (select count(*) from moved)::int as fired, q.id, q.run_id, q.idempotency_key,
       (select count(*) from woken)::int as woken
  from (select 1) as one
  left join queued q on true
`.trim();
