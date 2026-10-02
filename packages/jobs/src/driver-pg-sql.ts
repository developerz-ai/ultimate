// Every statement the Postgres driver runs, spelled out as template strings on purpose: an
// agent debugging a stuck queue should be able to read, run and correct the exact statement
// it saw in a log, without reassembling it from a builder. Kept beside the driver rather than
// inside it so the driver file stays the control flow and this one stays the wire format.
//
// The schema those statements run against is `driver-pg-ddl.ts` — a second responsibility, since
// it is applied once at boot and never by a driver method. Re-exported from here so the install
// point keeps the ONE import path every caller already uses.

export { SQL_JOBS_TABLE } from './driver-pg-ddl';
// The whole-`x_jobs`-row reads, split off at this file's size ceiling and re-exported for the
// same reason the DDL is. `JOB_ROW_COLUMNS` is imported as a value because `SQL_CANCEL` also
// returns a whole row and must project it identically — two spellings of one row shape is how
// one of them goes back to `returning *`.
export {
  JOB_ROW_COLUMNS,
  SQL_JOB_DEAD_LETTERS,
  SQL_JOB_GET,
  SQL_JOB_LIST,
  SQL_JOB_LIVE_HOLDER,
  SQL_JOB_REQUEUE,
  SQL_STEPS_FROM,
} from './driver-pg-jobs-sql';

export {
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_PENDING_COUNT,
  SQL_OUTBOX_PUBLISHED_JOB,
  SQL_OUTBOX_RELEASE,
  SQL_OUTBOX_STAGE,
} from './driver-pg-outbox-sql';
export { SQL_ACK, SQL_NACK } from './driver-pg-settle-sql';

import { JOB_ROW_COLUMNS } from './driver-pg-jobs-sql';
import { notifyJobReady } from './driver-pg-wake-sql';

/**
 * The insert, and its wake: `woke` is the notification's own column, evaluated once per inserted
 * row and absent when the conflict fired. `driver-pg-wake-sql.ts` says when it stays silent.
 *
 * `where not exists` is the outbox's half. A staged row is published under ITS OWN id
 * (`EnqueueRequest.id`), so a publish repeated after a crash meets the job the first one made —
 * in any state — and inserts nothing; the partial index below collapses a repeat only while that
 * job is still live. A select over `values`, so each parameter carries its cast.
 */
export const SQL_ENQUEUE = `
with inserted as (
  insert into x_jobs
    (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id,
     traceparent, enqueued_by)
  select $1::uuid, $2::text, $3::text, $4::jsonb, $5::text, $6::uuid, $7::int,
         case when to_timestamp($8::bigint / 1000.0) > now() then 'delayed' else 'ready' end,
         to_timestamp($8::bigint / 1000.0), $9::text, $10::text, $11::text
   where not exists (select 1 from x_jobs published where published.id = $1::uuid)
  on conflict (name, (coalesce(tenant_id, '')), idempotency_key)
    where state in ('ready', 'delayed', 'running', 'suspended')
    do nothing
  returning id, run_id, queue, run_at
)
select i.id, i.run_id,${notifyJobReady('i')}::text as woke
  from inserted i
`.trim();

/**
 * Scoped by NAME and TENANT as well as key, because the index is — a lookup narrower than the
 * index it reads answers with whichever stranger holds the key, and `{ deduped: true, id: <another
 * tenant's> }` is a cross-tenant handle, not just a missed run.
 *
 * `coalesce` on both sides, matching the index expression exactly: a bare `tenant_id = $3` never
 * matches a null row, so every tenantless enqueue would fall through to the "rejected but no live
 * row holds its idempotency key" refusal instead of finding its own live job.
 */
export const SQL_FIND_LIVE_BY_KEY = `
select id, run_id from x_jobs
 where name = $1
   and idempotency_key = $2
   and coalesce(tenant_id, '') = coalesce($3::text, '')
   and state in ('ready', 'delayed', 'running', 'suspended')
 limit 1
`.trim();

/**
 * The claim. SKIP LOCKED is the whole design: without it, worker 2 blocks on worker 1's row
 * lock and throughput collapses to one worker. `visible_at` in the predicate reclaims leases
 * abandoned by a crashed worker. `cancelled` is absent from every branch by construction — a
 * cancelled row is terminal, so it is never handed to a worker again.
 */
export const SQL_CLAIM = `
with claimed as (
  select id
    from x_jobs
   where queue = any($1::text[])
     and run_at <= now()
     and not exists (
       select 1 from x_job_pauses p where p.kind = 'queue' and p.name = x_jobs.queue
     )
     and (
       state in ('ready', 'delayed', 'suspended')
       or (state = 'running' and visible_at <= now())
     )
   order by run_at
   limit $2
     for update skip locked
)
update x_jobs j
   set state      = 'running',
       attempt    = j.attempt + 1,
       claims     = j.claims + 1,
       claimed_by = $3,
       visible_at = now() + ($4::bigint * interval '1 millisecond'),
       updated_at = now()
  from claimed c
 where j.id = c.id
returning j.id, j.name, j.queue, j.input, j.idempotency_key, j.run_id, j.attempt,
          j.max_attempts, j.state, j.tenant_id, j.last_error, j.claimed_by, j.claims,
          j.traceparent, j.enqueued_by,
          (extract(epoch from j.run_at)     * 1000)::bigint as run_at,
          (extract(epoch from j.visible_at) * 1000)::bigint as visible_at,
          (extract(epoch from j.created_at) * 1000)::bigint as created_at,
          (extract(epoch from j.updated_at) * 1000)::bigint as updated_at
`.trim();

/**
 * Stop a job from outside. `state <> 'done'` and not `state = 'ready'`: the runaway backfill this
 * exists for is `running`, and a job that already finished has nothing to stop. The worker holding
 * it learns on its next heartbeat, which no longer matches `state = 'running'`.
 */
export const SQL_CANCEL = `
update x_jobs
   set state = 'cancelled', visible_at = null, claimed_by = null,
       last_error = coalesce($2, last_error), updated_at = now()
 where id = $1 and state <> 'done'
returning ${JOB_ROW_COLUMNS}
`.trim();

/**
 * `returning id` so the caller can tell a renewal that LANDED from one that matched no row. A
 * heartbeat that updates nothing means this worker no longer owns the job — cancelled from
 * outside, or re-claimed after the lease lapsed — and continuing to run it is the double-execution
 * the lease exists to prevent.
 */
export const SQL_HEARTBEAT = `
update x_jobs
   set visible_at = now() + ($2::bigint * interval '1 millisecond'), updated_at = now()
 where id = $1 and state = 'running' and ($3::text is null or claimed_by = $3)
   and ($4::int is null or claims = $4)
returning id
`.trim();

/**
 * Six buckets a queue depth is SUMMED from, so a row may land in exactly one. `run_at > now()`
 * unqualified was every state's future row: a `step.sleep` job counted as `suspended` AND
 * `delayed`, a delayed dead-letter as `dead` AND `delayed`. The memory driver's `if/else if` chain
 * has always been exclusive, so `x jobs` reported one depth under `x dev` and a larger one in
 * production — off the same rows.
 */
export const SQL_STATS = `
select queue,
       count(*) filter (where state in ('ready', 'delayed') and run_at <= now()) as ready,
       count(*) filter (where state in ('ready', 'delayed') and run_at > now())  as delayed,
       count(*) filter (where state = 'running')                                as running,
       count(*) filter (where state = 'suspended')                              as suspended,
       count(*) filter (where state = 'failed')                                 as failed,
       count(*) filter (where state = 'dead')                                   as dead,
       coalesce(max(extract(epoch from now() - run_at)) filter
         (where state in ('ready', 'delayed') and run_at <= now()), 0) * 1000   as oldest_ready_ms
  from x_jobs
 group by queue
 order by queue
`.trim();

/**
 * Session-scoped, so a crashed node's lock releases itself — and released just as surely when a
 * POOLED connection goes back to the pool, which is why `createPgLeader` is not what a scheduler
 * running on a shared executor should use. See `SQL_LEADER_ACQUIRE` below.
 */
export const SQL_TRY_ADVISORY_LOCK = 'select pg_try_advisory_lock($1) as locked';
export const SQL_ADVISORY_UNLOCK = 'select pg_advisory_unlock($1) as unlocked';

/**
 * Lease-based leader election, safe on a pooled executor. One statement, and the primary key is
 * what makes it atomic: an insert wins an unheld key, and the `do update` only fires for the
 * holder itself (a renewal) or for a lease that has already expired. A second node reaching for a
 * live lease matches neither branch and gets no row back.
 */
export const SQL_LEADER_ACQUIRE = `
insert into x_scheduler_leader (lock_key, holder, expires_at)
values ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
on conflict (lock_key) do update
   set holder = excluded.holder, expires_at = excluded.expires_at
 where x_scheduler_leader.holder = excluded.holder
    or x_scheduler_leader.expires_at <= now()
returning holder
`.trim();

/** Only the holder may hand it back. A release by a node that already lost it is a no-op. */
export const SQL_LEADER_RELEASE = `
delete from x_scheduler_leader where lock_key = $1 and holder = $2
`.trim();

export const SQL_SCHEDULER_STATE_GET = `
select (extract(epoch from last_fired_at) * 1000)::bigint as last_fired_at
  from x_scheduler_state where task_name = $1
`.trim();

/**
 * `greatest` and not a plain assignment: the watermark only ever moves FORWARD. Two rounds that
 * overlapped across a rolling restart would otherwise let the older one rewind it, and every
 * occurrence between the two values fires a second time.
 */
export const SQL_SCHEDULER_STATE_MARK = `
insert into x_scheduler_state (task_name, last_fired_at, updated_at)
values ($1, to_timestamp($2 / 1000.0), now())
on conflict (task_name) do update
   set last_fired_at = greatest(x_scheduler_state.last_fired_at, excluded.last_fired_at),
       updated_at    = now()
`.trim();

/**
 * Take the lowest free slot under `limit`, or nothing. Race-safe without an advisory lock: the
 * `(lease_key, slot)` primary key serialises two workers that picked the same slot, and the
 * loser's `do update` is guarded on the slot having expired — a live slot returns no row, so the
 * grant is never doubled. Under contention this can refuse a slot that is genuinely free; a
 * refusal costs one poll interval and an over-grant costs the guarantee.
 */
export const SQL_LEASE_ACQUIRE = `
insert into x_job_leases (lease_key, slot, holder, expires_at)
select $1, s.slot, $2, now() + ($4::bigint * interval '1 millisecond')
  from generate_series(0, $3::int - 1) as s(slot)
 where not exists (
   select 1 from x_job_leases l
    where l.lease_key = $1 and l.slot = s.slot and l.expires_at > now()
 )
 order by s.slot
 limit 1
on conflict (lease_key, slot) do update
   set holder = excluded.holder, expires_at = excluded.expires_at
 where x_job_leases.expires_at <= now()
returning slot
`.trim();

/**
 * Two fences, and each answers a case the other cannot. `holder` answers "another worker has this
 * slot"; `expires_at > now()` answers "nobody has it YET" — a lapsed slot is one any worker may
 * take on its next acquire, so reviving it makes the TTL an expiry only other processes observe,
 * and `held()` (which counts live rows) disagreed with the holder's own belief in between. The
 * memory store has always answered `false` here, and `worker-fleet-slots.ts` turns that into
 * `X_JOB_SLOT_LOST`; without this line the same lapsed slot cancelled the run under `x dev` and
 * silently continued in production.
 */
export const SQL_LEASE_RENEW = `
update x_job_leases
   set expires_at = now() + ($4::bigint * interval '1 millisecond')
 where lease_key = $1 and slot = $2::int and holder = $3 and expires_at > now()
returning slot
`.trim();

export const SQL_LEASE_RELEASE = `
delete from x_job_leases where lease_key = $1 and slot = $2::int and holder = $3
`.trim();

/**
 * Who holds the LIVE slots of one key, in slot order. Read only after an acquire was refused, to
 * tell a key another run holds from one this run's own previous claim still does — the acquire
 * itself stays the one atomic decision, and this never grants anything.
 */
export const SQL_LEASE_HOLDERS = `
select holder from x_job_leases
 where lease_key = $1 and expires_at > now()
 order by slot
`.trim();

/**
 * Both instants are the DATABASE's: `published_at` is `now()` and the expiry is counted from it.
 * They were bound from the publisher's process clock, and every reader compares them with
 * something else — `now()` in `SQL_EVENT_FIND`, a consumer's "after" — so a pod whose clock was
 * off wrote an event that had expired before it was inserted, or that came "before" a question
 * asked a minute earlier. `floor`, never a rounding cast: a stamp is never later than the row.
 *
 * $1 id, $2 name, $3 payload, $4 correlation key, $5 ttl (ms).
 */
export const SQL_EVENT_PUBLISH = `
insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
values ($1, $2, $3::jsonb, $4, now(), now() + ($5::bigint * interval '1 millisecond'))
returning floor(extract(epoch from published_at) * 1000)::bigint as published_at,
          floor(extract(epoch from expires_at)   * 1000)::bigint as expires_at
`.trim();

/** The bus's clock — the instant a publish issued now would be stamped with. */
export const SQL_EVENT_NOW = `
select floor(extract(epoch from now()) * 1000)::bigint as now
`.trim();

/**
 * Earliest matching event at or after `afterMs`, so a resumed step consumes events in publication
 * order rather than jumping to the newest one — the memory bus's rule, in SQL.
 */
export const SQL_EVENT_FIND = `
select payload, (extract(epoch from published_at) * 1000)::bigint as published_at
  from x_job_events
 where name = $1
   and expires_at > now()
   and published_at >= to_timestamp($3 / 1000.0)
   and ($2::text is null or correlation_key = $2)
 order by published_at
 limit 1
`.trim();

export const SQL_EVENT_LIST = `
select id, name, payload, correlation_key,
       (extract(epoch from published_at) * 1000)::bigint as published_at,
       (extract(epoch from expires_at)   * 1000)::bigint as expires_at
  from x_job_events
 where ($1::text is null or name = $1)
 order by published_at
 limit $2
`.trim();

export const SQL_EVENT_PURGE = `delete from x_job_events where expires_at <= now()`;

export const SQL_STEP_GET = `
select run_id, name, status, output, attempts, error,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from completed_at) * 1000)::bigint as completed_at,
       (extract(epoch from wake_at)      * 1000)::bigint as wake_at,
       event, correlation_key
  from x_job_steps where run_id = $1 and name = $2
`.trim();

/**
 * `list`'s projection is `SQL_STEP_GET`'s, minus the name predicate. It exists as its own constant
 * because `select *` was what `list` issued: a client that decodes `timestamptz` as text — most of
 * them, without a type map — handed `toStepRecord` a date string, `Number()` made it `NaN`, and
 * `x jobs show` printed one per step. Every other statement in this file asks Postgres to do the
 * conversion; this is that rule applied to the one statement that had opted out of it.
 */
export const SQL_STEP_LIST = `
select run_id, name, status, output, attempts, error,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from completed_at) * 1000)::bigint as completed_at,
       (extract(epoch from wake_at)      * 1000)::bigint as wake_at,
       event, correlation_key
  from x_job_steps where run_id = $1 order by started_at
`.trim();

export const SQL_STEP_PUT = `
insert into x_job_steps
  (run_id, name, status, output, started_at, completed_at, wake_at, event,
   correlation_key, attempts, error)
values ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0),
        case when $6::bigint is null then null else to_timestamp($6 / 1000.0) end,
        case when $7::bigint is null then null else to_timestamp($7 / 1000.0) end,
        $8, $9, $10, $11)
on conflict (run_id, name) do update
   set status = excluded.status, output = excluded.output,
       completed_at = excluded.completed_at, wake_at = excluded.wake_at,
       attempts = excluded.attempts, error = excluded.error
`.trim();

/**
 * Open the row, or adopt the one an earlier attempt of the SAME run opened. `do update` rather
 * than `do nothing` because a failed attempt left `failed` behind and this one is running:
 * `started_at`, `app_version` and `checksum` stay as the pass began, and the progress columns
 * stay where the last attempt got to.
 *
 * `completed_at` is cleared, and is the one column here that is not preserved: `finish` stamps it
 * for `failed` as well as for `completed`, so a retried run that kept it would report a running
 * pass with a completion time in the past — on `x db backfill --list`, on `x jobs show` and in
 * `/_x`, all of which project that column straight through.
 */
export const SQL_BACKFILL_START = `
insert into x_backfills (run_id, name, checksum, app_version)
values ($1, $2, $3, $4)
on conflict (run_id) do update set status = 'running', completed_at = null
`.trim();

export const SQL_BACKFILL_PROGRESS = `
update x_backfills
   set rows_processed = $2, last_cursor = $3
 where run_id = $1
`.trim();

/** A failure KEEPS its cursor: where a pass stopped is the first thing anyone asks about one. */
export const SQL_BACKFILL_FINISH = `
update x_backfills
   set status         = $2,
       rows_processed = $3,
       completed_at   = now(),
       last_cursor    = case when $2 = 'completed' then null else last_cursor end
 where run_id = $1
`.trim();

/**
 * `$3::uuid`, where its two neighbours are `::text`, because `run_id` IS a uuid: the cast on the
 * null test is what tells Postgres the parameter's type, and `::text` there pins it to text for
 * the comparison below it — `uuid = text` has no operator, so every call failed, filtered or not.
 * Nothing hand-types this value; it arrives from a job record the same database wrote.
 */
export const SQL_BACKFILL_LIST = `
select run_id, name, checksum, status, app_version, rows_processed, last_cursor,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from completed_at) * 1000)::bigint as completed_at
  from x_backfills
 where ($1::text is null or name = $1)
   and ($2::text is null or status = $2)
   and ($3::uuid is null or run_id = $3)
 order by started_at desc
 limit $4
`.trim();
