// The SCHEMA the Postgres driver installs, apart from the statements it runs against it
// (`driver-pg-sql.ts`): one constant an operator can read, apply and diff on its own.
//
// `SQL_JOBS_TABLE` is the queue's ONE install point — every durable table this package owns is
// declared in it, so boot applies one constant and `x dev` and production get the same schema.
// A table that shipped is extended with `alter table ... add column if not exists`, never by
// editing its `create`: `create table if not exists` is a no-op against a database that already
// has the table, so a new column added only there reaches new installs and nothing else.
//
// `dev-queue.ts` splits this constant on `;` and applies it statement by statement, so comments
// inside it carry NO semicolons and NO apostrophes — a `;` in prose yields a comment-only chunk
// and an odd quote count means a `;` sits inside an open literal. `driver-pg-sql.test.ts` pins
// both, plus the shape of every chunk the split yields.

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

-- The enqueuing requests trace and actor, carried onto the row so the job span is a CHILD of
-- the request that queued it and an audit trail can say who asked. Added by alter because
-- x_jobs shipped without them.
alter table x_jobs add column if not exists traceparent text;

alter table x_jobs add column if not exists enqueued_by text;

-- Partial unique index: one LIVE job per (name, idempotency key). Completed rows stay for
-- history, so re-running the same work tomorrow is allowed and re-delivering it today is not.
--
-- The NAME is in the key, and its absence was silent data loss: two jobs that happened to derive
-- the same natural key from the same input ("user:42") shared one namespace, so the second
-- enqueue deduped against the FIRST jobs row and returned its id. The work never ran, no error
-- was raised, and the queue showed one healthy job. The old index is dropped rather than left
-- beside the new one — it is strictly narrower, so keeping it would keep enforcing exactly the
-- collision this fixes.
drop index if exists x_jobs_idempotency_live_idx;

create unique index if not exists x_jobs_name_idempotency_live_idx
  on x_jobs (name, idempotency_key)
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

-- The transactional outbox. Staged by the SAME connection as the callers business rows, so it
-- commits or vanishes with them. The relay publishes what committed.
create table if not exists x_outbox (
  id              uuid primary key,
  job             text        not null,
  queue           text        not null default 'default',
  input           jsonb       not null,
  idempotency_key text        not null,
  max_attempts    int         not null default 3,
  run_at          timestamptz not null default now(),
  staged_at       timestamptz not null default now(),
  tenant_id       text,
  traceparent     text,
  enqueued_by     text,
  published_at    timestamptz
);

create index if not exists x_outbox_unpublished_idx
  on x_outbox (staged_at) where published_at is null;

-- The relays claim lease. A claim stamped in the same statement that locks the row is what stops
-- two relays publishing one row twice: for update skip locked holds its locks only until that
-- statement ends, which under autocommit is before claim returns. claimed_at is also what gives
-- back the rows of a relay that died mid-batch, since a claim nothing can expire strands them.
-- Added by alter because x_outbox shipped without them.
alter table x_outbox add column if not exists claimed_at timestamptz;

alter table x_outbox add column if not exists claimed_by text;

-- The scheduler watermark. Without a durable one a redeployed scheduler has no idea what the
-- pod it replaced already fired, so runRound takes the arming branch and every occurrence
-- between the two processes is dropped with nothing logged.
create table if not exists x_scheduler_state (
  task_name     text primary key,
  last_fired_at timestamptz not null,
  updated_at    timestamptz not null default now()
);

-- Leader election as an EXPIRING LEASE rather than a session advisory lock: the executor this
-- package is handed is a pool, and a session-level pg_try_advisory_lock is released the moment
-- that connection goes back to it. A row with an expiry needs no connection affinity at all.
create table if not exists x_scheduler_leader (
  lock_key   text primary key,
  holder     text        not null,
  expires_at timestamptz not null
);

-- Fleet-wide concurrency. One row per HELD SLOT, so the primary key is what serialises two
-- workers reaching for the same slot — job.concurrency was documented, in the manifest, and
-- enforced by nothing before this table existed.
create table if not exists x_job_leases (
  lease_key  text        not null,
  slot       int         not null,
  holder     text        not null,
  expires_at timestamptz not null,
  primary key (lease_key, slot)
);

create index if not exists x_job_leases_expiry_idx on x_job_leases (expires_at);

-- Events step.waitForEvent consumes. Stored and not broadcast: the publisher is a web pod and
-- the resumer is a worker pod, so an in-heap bus strands every waiting run in a real deployment.
create table if not exists x_job_events (
  id              uuid primary key,
  name            text        not null,
  payload         jsonb       not null,
  correlation_key text,
  published_at    timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists x_job_events_lookup_idx
  on x_job_events (name, published_at);
`.trim();

/**
 * Kept as its own constant because it is a public export and `x_outbox` is a table an operator
 * may need to create alone. It is ALSO inside `SQL_JOBS_TABLE`, which is the one boot applies —
 * two install points for one table is how the outbox came to be documented and never created.
 */
export const SQL_OUTBOX_TABLE = `
create table if not exists x_outbox (
  id              uuid primary key,
  job             text        not null,
  queue           text        not null default 'default',
  input           jsonb       not null,
  idempotency_key text        not null,
  max_attempts    int         not null default 3,
  run_at          timestamptz not null default now(),
  staged_at       timestamptz not null default now(),
  tenant_id       text,
  traceparent     text,
  enqueued_by     text,
  published_at    timestamptz
);
create index if not exists x_outbox_unpublished_idx
  on x_outbox (staged_at) where published_at is null;
alter table x_outbox add column if not exists claimed_at timestamptz;
alter table x_outbox add column if not exists claimed_by text;
`.trim();
