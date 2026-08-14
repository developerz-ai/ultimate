// Every statement the Postgres driver runs, spelled out as template strings on purpose: an
// agent debugging a stuck queue should be able to read, run and correct the exact statement
// it saw in a log, without reassembling it from a builder. Kept beside the driver rather than
// inside it so the driver file stays the control flow and this one stays the wire format.

export const SQL_JOBS_TABLE = `
create table if not exists x_jobs (
  id              uuid primary key,
  name            text        not null,
  queue           text        not null default 'default',
  input           jsonb       not null,
  idempotency_key text        not null,
  run_id          uuid        not null,
  attempt         int         not null default 0,
  max_attempts    int         not null default 3,
  state           text        not null default 'ready',
  run_at          timestamptz not null default now(),
  visible_at      timestamptz,
  claimed_by      text,
  last_error      text,
  tenant_id       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Partial unique index: one LIVE job per idempotency key. Completed rows stay for history,
-- so re-running the same work tomorrow is allowed and re-delivering it today is not.
create unique index if not exists x_jobs_idempotency_live_idx
  on x_jobs (idempotency_key)
  where state in ('ready', 'delayed', 'running', 'suspended');

create index if not exists x_jobs_claim_idx
  on x_jobs (queue, run_at)
  where state in ('ready', 'delayed', 'suspended');

create table if not exists x_job_steps (
  run_id       uuid        not null,
  name         text        not null,
  status       text        not null,
  output       jsonb,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  wake_at      timestamptz,
  event        text,
  correlation_key text,
  attempts     int         not null default 1,
  error        text,
  primary key (run_id, name)
);

-- The backfill ledger. Keyed by RUN, not by name: a completed name blocks a re-run, and a forced
-- one writes a new row, so what each pass swept survives the rerun that followed it.
create table if not exists x_backfills (
  run_id         uuid primary key,
  name           text        not null,
  checksum       text        not null,
  status         text        not null default 'running',
  app_version    text        not null,
  rows_processed bigint      not null default 0,
  last_cursor    text,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists x_backfills_name_idx on x_backfills (name, started_at desc);
`.trim();

export const SQL_ENQUEUE = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id)
values
  ($1, $2, $3, $4::jsonb, $5, $6, $7,
   case when to_timestamp($8 / 1000.0) > now() then 'delayed' else 'ready' end,
   to_timestamp($8 / 1000.0), $9)
on conflict (idempotency_key)
  where state in ('ready', 'delayed', 'running', 'suspended')
  do nothing
returning id, run_id
`.trim();

export const SQL_FIND_LIVE_BY_KEY = `
select id, run_id from x_jobs
 where idempotency_key = $1
   and state in ('ready', 'delayed', 'running', 'suspended')
 limit 1
`.trim();

/**
 * The claim. SKIP LOCKED is the whole design: without it, worker 2 blocks on worker 1's row
 * lock and throughput collapses to one worker. `visible_at` in the predicate reclaims leases
 * abandoned by a crashed worker.
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
          (extract(epoch from j.run_at)     * 1000)::bigint as run_at,
          (extract(epoch from j.visible_at) * 1000)::bigint as visible_at,
          (extract(epoch from j.created_at) * 1000)::bigint as created_at,
          (extract(epoch from j.updated_at) * 1000)::bigint as updated_at
`.trim();

export const SQL_ACK = `
update x_jobs
   set state = 'done', visible_at = null, claimed_by = null, updated_at = now()
 where id = $1
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
 where id = $1
`.trim();

export const SQL_HEARTBEAT = `
update x_jobs
   set visible_at = now() + ($2::bigint * interval '1 millisecond'), updated_at = now()
 where id = $1 and state = 'running'
`.trim();

export const SQL_STATS = `
select queue,
       count(*) filter (where state = 'ready' and run_at <= now())              as ready,
       count(*) filter (where state = 'delayed' or run_at > now())              as delayed,
       count(*) filter (where state = 'running')                                as running,
       count(*) filter (where state = 'suspended')                              as suspended,
       count(*) filter (where state = 'dead')                                   as dead,
       coalesce(max(extract(epoch from now() - run_at)) filter
         (where state = 'ready' and run_at <= now()), 0) * 1000                 as oldest_ready_ms
  from x_jobs
 group by queue
 order by queue
`.trim();

/** Scheduler leader election. Session-scoped, so a crashed node's lock releases itself. */
export const SQL_TRY_ADVISORY_LOCK = 'select pg_try_advisory_lock($1) as locked';
export const SQL_ADVISORY_UNLOCK = 'select pg_advisory_unlock($1) as unlocked';

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
 */
export const SQL_BACKFILL_START = `
insert into x_backfills (run_id, name, checksum, app_version)
values ($1, $2, $3, $4)
on conflict (run_id) do update set status = 'running'
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

export const SQL_BACKFILL_LIST = `
select run_id, name, checksum, status, app_version, rows_processed, last_cursor,
       (extract(epoch from started_at)   * 1000)::bigint as started_at,
       (extract(epoch from completed_at) * 1000)::bigint as completed_at
  from x_backfills
 where ($1::text is null or name = $1)
   and ($2::text is null or status = $2)
 order by started_at desc
 limit $3
`.trim();
