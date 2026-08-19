// Every statement the Postgres driver runs, spelled out as template strings on purpose: an
// agent debugging a stuck queue should be able to read, run and correct the exact statement
// it saw in a log, without reassembling it from a builder. Kept beside the driver rather than
// inside it so the driver file stays the control flow and this one stays the wire format.
//
// The schema those statements run against is `driver-pg-ddl.ts` — a second responsibility, since
// it is applied once at boot and never by a driver method. Re-exported from here so the install
// point keeps the ONE import path every caller already uses.

export { SQL_JOBS_TABLE, SQL_OUTBOX_TABLE } from './driver-pg-ddl';

export const SQL_ENQUEUE = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id,
   traceparent, enqueued_by)
values
  ($1, $2, $3, $4::jsonb, $5, $6, $7,
   case when to_timestamp($8 / 1000.0) > now() then 'delayed' else 'ready' end,
   to_timestamp($8 / 1000.0), $9, $10, $11)
on conflict (name, idempotency_key)
  where state in ('ready', 'delayed', 'running', 'suspended')
  do nothing
returning id, run_id
`.trim();

/** Scoped by NAME as well as key — the index is, so a lookup that was not would find a stranger. */
export const SQL_FIND_LIVE_BY_KEY = `
select id, run_id from x_jobs
 where name = $1
   and idempotency_key = $2
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
       claimed_by = $3,
       visible_at = now() + ($4::bigint * interval '1 millisecond'),
       updated_at = now()
  from claimed c
 where j.id = c.id
returning j.id, j.name, j.queue, j.input, j.idempotency_key, j.run_id, j.attempt,
          j.max_attempts, j.state, j.tenant_id, j.last_error, j.claimed_by,
          j.traceparent, j.enqueued_by,
          (extract(epoch from j.run_at)     * 1000)::bigint as run_at,
          (extract(epoch from j.visible_at) * 1000)::bigint as visible_at,
          (extract(epoch from j.created_at) * 1000)::bigint as created_at,
          (extract(epoch from j.updated_at) * 1000)::bigint as updated_at
`.trim();

/**
 * `and state = 'running'` is a FENCE, not a filter. Without it an ack from the worker that was
 * cancelled — or from one whose lease lapsed and whose job another worker already re-claimed —
 * overwrites the row it no longer owns: `x jobs cancel` would be undone by the next settle, and
 * a re-delivered job would be marked done by the attempt that lost it.
 */
export const SQL_ACK = `
update x_jobs
   set state = 'done', visible_at = null, claimed_by = null, updated_at = now()
 where id = $1 and state = 'running'
`.trim();

export const SQL_NACK = `
update x_jobs
   set state      = $2,
       attempt    = case when $3::boolean then attempt else greatest(attempt - 1, 0) end,
       run_at     = now() + ($4::bigint * interval '1 millisecond'),
       visible_at = null,
       claimed_by = null,
       last_error = coalesce($5, last_error),
       updated_at = now()
 where id = $1 and state = 'running'
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
returning *
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
returning id
`.trim();

/**
 * Five buckets a queue depth is SUMMED from, so a row may land in exactly one. `run_at > now()`
 * unqualified was every state's future row: a `step.sleep` job counted as `suspended` AND
 * `delayed`, a delayed dead-letter as `dead` AND `delayed`. The memory driver's `if/else if` chain
 * has always been exclusive, so `x jobs` reported one depth under `x dev` and a larger one in
 * production — off the same rows.
 */
export const SQL_STATS = `
select queue,
       count(*) filter (where state = 'ready' and run_at <= now())              as ready,
       count(*) filter (where state = 'delayed'
                           or (state = 'ready' and run_at > now()))             as delayed,
       count(*) filter (where state = 'running')                                as running,
       count(*) filter (where state = 'suspended')                              as suspended,
       count(*) filter (where state = 'dead')                                   as dead,
       coalesce(max(extract(epoch from now() - run_at)) filter
         (where state = 'ready' and run_at <= now()), 0) * 1000                 as oldest_ready_ms
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

export const SQL_EVENT_PUBLISH = `
insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
values ($1, $2, $3::jsonb, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))
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

export const SQL_OUTBOX_STAGE = `
insert into x_outbox
  (id, job, queue, input, idempotency_key, max_attempts, run_at, staged_at, tenant_id,
   traceparent, enqueued_by)
values ($1, $2, $3, $4::jsonb, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0),
        $9, $10, $11)
`.trim();

/**
 * The claim, and it has to be ONE statement. `for update skip locked` in a bare select holds its
 * row locks only until that statement ends — under autocommit, before `claim()` even resolves — so
 * two relays polling 200ms apart read the same unpublished rows and both hand them to `enqueue`.
 * `SQL_ENQUEUE` collapses the repeat only while the first job is still LIVE: its conflict target
 * is a partial index over the live states, so a second publish landing after that job reached a
 * terminal state inserts a second row and the handler runs again. (The mechanism is Postgres
 * semantics; how often the two orderings line up in a deployment was never measured.)
 *
 * So the lock and the claim commit together, the CTE shape `SQL_CLAIM` already uses, and
 * `claimed_at` is a LEASE: `$2` is the window after which a row a dead relay was holding is
 * claimable again, because a claim nothing can expire strands its rows forever.
 *
 * The outer `select ... order by staged_at, id` is not cosmetic. `update ... returning` has no
 * defined row order and the relay publishes in the order it is handed rows, so an app staging
 * `createInvoice` then `chargeCard` in one transaction depends on this line.
 *
 * `, id` is what makes that key TOTAL, and the CTE needs it as much as the projection does: every
 * row staged in one transaction shares a `staged_at`, so `staged_at` alone leaves the tie to the
 * planner — which rows a `limit` takes, and in which order they publish, then differ between two
 * relays and between two runs of one relay. No column was added for it: `id` is a UUIDv7 minted by
 * `uuid()`, monotonic and already the primary key, so the tiebreak IS stage order.
 */
export const SQL_OUTBOX_CLAIM = `
with claimable as (
  select id
    from x_outbox
   where published_at is null
     and (claimed_at is null
          or claimed_at <= now() - ($2::bigint * interval '1 millisecond'))
   order by staged_at, id
   limit $1
     for update skip locked
), claimed as (
  update x_outbox o
     set claimed_at = now(), claimed_by = $3
    from claimable c
   where o.id = c.id
  returning o.id, o.job, o.queue, o.input, o.idempotency_key, o.max_attempts, o.tenant_id,
            o.traceparent, o.enqueued_by, o.claimed_by, o.run_at, o.staged_at
)
select id, job, queue, input, idempotency_key, max_attempts, tenant_id,
       traceparent, enqueued_by, claimed_by,
       (extract(epoch from run_at) * 1000)::bigint    as run_at,
       (extract(epoch from staged_at) * 1000)::bigint as staged_at
  from claimed
 order by staged_at, id
`.trim();

/**
 * Hand a claim back early. The relay stops its batch on the first publish that fails, and without
 * this the rows behind it would wait out the whole lease before any relay could retry them — a
 * pool blip during a failover becoming tens of seconds of unpublished, committed work.
 *
 * Fenced on `published_at is null` so it can never unclaim a row some other pass already
 * published, AND on `claimed_by` so it can never unclaim one a NEWER claimant now holds: a relay
 * whose lease lapsed while it stalled wakes into a world where its batch is another relay's, and
 * an unfenced release frees rows that relay is mid-publish on — a third relay claims them and
 * publishes them again, which is the duplicate the lease exists to prevent.
 */
export const SQL_OUTBOX_RELEASE = `
update x_outbox
   set claimed_at = null, claimed_by = null
 where id = any($1::uuid[]) and published_at is null and claimed_by = $2
`.trim();

/**
 * Same fence, and here it is the more expensive one to miss: marking a row published is LOSING it,
 * so a lapsed claimant stamping a row the current one has not published yet drops that job with
 * nothing to notice. `published_at is null` makes the stamp first-writer-wins rather than a
 * rewrite of an audit timestamp.
 */
export const SQL_OUTBOX_MARK_PUBLISHED = `
update x_outbox set published_at = to_timestamp($2 / 1000.0)
 where id = $1 and published_at is null and claimed_by = $3
`.trim();

export const SQL_OUTBOX_PENDING_COUNT = `
select count(*)::bigint as pending from x_outbox where published_at is null
`.trim();

export const SQL_STEP_GET = `
select run_id, name, status, output, attempts, error,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from completed_at) * 1000)::bigint as completed_at,
       (extract(epoch from wake_at)      * 1000)::bigint as wake_at,
       event, correlation_key
  from x_job_steps where run_id = $1 and name = $2
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
