// The single enqueue's statements: the insert (`SQL_ENQUEUE`), its debounce twin
// (`SQL_ENQUEUE_REPLACE`, `onConflict: 'replace'`) and the backlog count a job declaring
// `maxPending` asks before either (`SQL_BACKLOG`). Split from `driver-pg-sql.ts`, which re-exports
// them, at that file's size ceiling.

import { notifyJobReady } from './driver-pg-wake-sql';

/**
 * What a LIVE holder of the key does to the insert: nothing, or — debounce — take this request's
 * input, run time and expiry while it still waits. A running or suspended holder fails the `where`,
 * the statement returns no row, and the driver answers it as the dedupe it is. Two statements and
 * not one `do update ... where $flag`: a `do update` locks the holder even when its `where` is
 * false, and the plain dedupe is the hot path.
 *
 * FENCED by staged order: `debounced_id` is the id of the request whose input the row holds (its
 * own id until a replace lands), and only a NEWER request — a greater uuidV7, minted at stage or at
 * the direct enqueue — moves it. The outbox relay publishes a row again after a crash before its
 * mark, possibly after a newer row went out; unfenced, that repeat put the older input back.
 */
const onConflict = (replace: boolean): string =>
  replace
    ? `do update
       set input = excluded.input, run_at = excluded.run_at, state = excluded.state,
           expires_at = excluded.expires_at, debounced_id = excluded.debounced_id,
           updated_at = now()
     where x_jobs.state in ('ready', 'delayed')
       and coalesce(x_jobs.debounced_id, x_jobs.id) < excluded.debounced_id`
    : 'do nothing';

/**
 * The replace's second fence: a row under the key — live OR finished — already holding this
 * request's input or a newer one. A replace that landed on a holder which has since run leaves no
 * row of its own id, so the `not exists` on `$1` cannot see it; this does, off
 * `x_jobs_debounced_idx`, which holds only the rows a debounce wrote. Such a request inserts
 * nothing and is answered with that row, deduped — a stale run is never made.
 */
const NEWER = `
newer as (
  select n.id, n.run_id
    from x_jobs n
   where n.name = $2::text and coalesce(n.tenant_id, '') = coalesce($9::text, '')
     and n.idempotency_key = $5::text and n.debounced_id >= $1::uuid
   order by n.debounced_id desc
   limit 1
), `;

/** The insert's half of the fence: nothing is written while `newer` holds a row. */
const NOT_NEWER = `
     and not exists (select 1 from newer)`;

/** The answer when `newer` held a row: that row, deduped, and no wake — nothing became due. */
const NEWER_ARM = `
union all
select n.id, n.run_id, true as replaced, null::text as woke
  from newer n`;

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
 * moved a holder — or `newer` answered — and it is answered `deduped`, under that row's ids.
 */
const enqueueSql = (replace: boolean): string =>
  `
with ${replace ? NEWER : ''}inserted as (
  insert into x_jobs
    (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id,
     traceparent, enqueued_by, expires_at, debounced_id)
  select $1::uuid, $2::text, $3::text, $4::jsonb, $5::text, $6::uuid, $7::int,
         case when to_timestamp($8::numeric::bigint / 1000.0) > now() then 'delayed' else 'ready' end,
         to_timestamp($8::numeric::bigint / 1000.0), $9::text, $10::text, $11::text,
         to_timestamp($12::numeric::bigint / 1000.0), ${replace ? '$1::uuid' : 'null::uuid'}
   where not exists (select 1 from x_jobs published where published.id = $1::uuid)${replace ? NOT_NEWER : ''}
  on conflict (name, (coalesce(tenant_id, '')), idempotency_key)
    where state in ('ready', 'delayed', 'running', 'suspended')
    ${onConflict(replace)}
  returning id, run_id, queue, run_at
)
select i.id, i.run_id, i.id <> $1::uuid as replaced,${notifyJobReady('i')}::text as woke
  from inserted i${replace ? NEWER_ARM : ''}
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
