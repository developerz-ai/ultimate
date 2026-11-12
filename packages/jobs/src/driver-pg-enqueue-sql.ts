// The single enqueue's statements: the insert (`SQL_ENQUEUE`), its debounce twin
// (`SQL_ENQUEUE_REPLACE`, `onConflict: 'replace'`) and the backlog count a job declaring
// `maxPending` asks before either (`SQL_BACKLOG`). Split from `driver-pg-sql.ts`, which re-exports
// them, at that file's size ceiling.

import { notifyJobReady } from './driver-pg-wake-sql';

/**
 * What a LIVE holder of the key does to the insert: nothing, or — debounce — take this request's
 * input and run time while it still waits. A running or suspended holder fails the `where`, the
 * statement returns no row, and the driver answers it as the dedupe it is. Two statements and not
 * one `do update ... where $flag`: a `do update` locks the holder even when its `where` is false,
 * and the plain dedupe is the hot path.
 */
const onConflict = (replace: boolean): string =>
  replace
    ? `do update
       set input = excluded.input, run_at = excluded.run_at, state = excluded.state,
           updated_at = now()
     where x_jobs.state in ('ready', 'delayed')`
    : 'do nothing';

/**
 * The insert, and its wake: `woke` is the notification's own column, evaluated once per returned
 * row and absent when the conflict fired. `driver-pg-wake-sql.ts` says when it stays silent.
 *
 * `where not exists` is the outbox's half. A staged row is published under ITS OWN id
 * (`EnqueueRequest.id`), so a publish repeated after a crash meets the job the first one made —
 * in any state — and inserts nothing; the partial index below collapses a repeat only while that
 * job is still live. A select over `values`, so each parameter carries its cast.
 *
 * `$8::numeric::bigint`, never `$8::bigint`: a fractional epoch ms — `now + Math.random() * 1000`
 * — binds as text `1767225660000.5` on some clients, which no `bigint` reads (`22P02`). Through
 * `numeric` it is rounded to the ms, the instant `SQL_ENQUEUE_MANY` stores for the same request.
 * `$12` is `expiresAt` the same way, and null stays null (`to_timestamp(null)`).
 *
 * `replaced`: the row returned is not the one this statement minted (`$1`), so the replace arm
 * moved a holder — answered `deduped`, under the holder's ids.
 */
const enqueueSql = (replace: boolean): string =>
  `
with inserted as (
  insert into x_jobs
    (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id,
     traceparent, enqueued_by, expires_at)
  select $1::uuid, $2::text, $3::text, $4::jsonb, $5::text, $6::uuid, $7::int,
         case when to_timestamp($8::numeric::bigint / 1000.0) > now() then 'delayed' else 'ready' end,
         to_timestamp($8::numeric::bigint / 1000.0), $9::text, $10::text, $11::text,
         to_timestamp($12::numeric::bigint / 1000.0)
   where not exists (select 1 from x_jobs published where published.id = $1::uuid)
  on conflict (name, (coalesce(tenant_id, '')), idempotency_key)
    where state in ('ready', 'delayed', 'running', 'suspended')
    ${onConflict(replace)}
  returning id, run_id, queue, run_at
)
select i.id, i.run_id, i.id <> $1::uuid as replaced,${notifyJobReady('i')}::text as woke
  from inserted i
`.trim();

export const SQL_ENQUEUE = enqueueSql(false);

export const SQL_ENQUEUE_REPLACE = enqueueSql(true);

/**
 * How many rows wait on `$1` — `ready` or `delayed`, the backlog `maxPending` caps — counted no
 * further than `$2`, so a drowning queue costs the count its cap and never a pass over the whole
 * backlog. `x_jobs_depth_idx` (`queue, state, run_at`) serves it as two ranges.
 */
export const SQL_BACKLOG = `
select count(*)::int as n
  from (select 1 from x_jobs
         where queue = $1 and state in ('ready', 'delayed')
         limit $2::int) waiting
`.trim();
