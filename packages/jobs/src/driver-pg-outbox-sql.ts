// Every statement the `x_outbox` store runs. Split off `driver-pg-sql.ts` at its size ceiling and
// re-exported from it, the way the settle and whole-row statements are.

import { NOTIFY_STAGED } from './driver-pg-wake-sql';

/**
 * The stage, and its wake. One statement on the CALLER's connection, so the notification is in
 * the business transaction with the row: delivered when it commits, never when it rolls back.
 */
export const SQL_OUTBOX_STAGE = `
with staged as (
  insert into x_outbox
    (id, job, queue, input, idempotency_key, max_attempts, run_at, staged_at, tenant_id,
     traceparent, enqueued_by, run_id, on_conflict, expires_at)
  values ($1, $2, $3, $4::jsonb, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0),
          $9, $10, $11, $12, $13::text, to_timestamp($14::numeric / 1000.0))
  returning id
)
select id,${NOTIFY_STAGED}::text as woke
  from staged
`.trim();

/**
 * `SQL_OUTBOX_STAGE` for a whole chunk: each element of `$1` one row, in order, and the wake ONCE
 * for the statement rather than once per row — the same `NOTIFY_STAGED` clause, on the caller's
 * connection, so it still commits or vanishes with the business rows. `staged_at` is shared by
 * the chunk and `id` (a UUIDv7) orders it, which is the claim's total key. Both instants cross as
 * `numeric`, never `bigint`: a fractional epoch ms is no `bigint` literal, and `SQL_OUTBOX_STAGE`
 * takes one — a `22P02` here failed the caller's whole transaction.
 */
export const SQL_OUTBOX_STAGE_MANY = `
with staged as (
  insert into x_outbox
    (id, job, queue, input, idempotency_key, max_attempts, run_at, staged_at, tenant_id,
     traceparent, enqueued_by, run_id, on_conflict, expires_at)
  select (r->>'id')::uuid, r->>'job', r->>'queue', r->'input', r->>'idempotencyKey',
         (r->>'maxAttempts')::int, to_timestamp((r->>'runAt')::numeric / 1000.0),
         to_timestamp((r->>'stagedAt')::numeric / 1000.0), r->>'tenantId', r->>'traceparent',
         r->>'enqueuedBy', (r->>'runId')::uuid, r->>'onConflict',
         to_timestamp((r->>'expiresAt')::numeric / 1000.0)
    from jsonb_array_elements($1::jsonb) with ordinality as t(r, ord)
   order by t.ord
  returning id
)
select count(*)::bigint as staged,${NOTIFY_STAGED}::text as woke
  from staged
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
const outboxClaimSql = (horizon: boolean): string =>
  `
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
  returning o.id, o.run_id, o.job, o.queue, o.input, o.idempotency_key, o.max_attempts,
            o.tenant_id, o.traceparent, o.enqueued_by, o.claimed_by, o.run_at, o.staged_at,
            o.on_conflict, o.expires_at
)
select id, run_id, job, queue, input, idempotency_key, max_attempts, tenant_id,
       traceparent, enqueued_by, claimed_by, on_conflict,
       (extract(epoch from run_at) * 1000)::bigint     as run_at,
       (extract(epoch from staged_at) * 1000)::bigint  as staged_at,
       (extract(epoch from expires_at) * 1000)::bigint as expires_at${horizon ? HORIZON_COLUMN : ''}
  from claimed${horizon ? OUTBOX_HORIZON_ARM : ''}
 order by staged_at, id
`.trim();

const HORIZON_COLUMN = `,
       null::bigint as due_in_ms`;

/**
 * With nothing claimed, ONE row of nulls carrying `due_in_ms`: when the first row a relay holds
 * has its lease lapse — the only outbox row no `NOTIFY_STAGED` announces, because its relay died
 * holding it. Unclaimed rows are absent by construction: one the claim skipped is locked by a
 * peer's claim in flight. Read over `x_outbox_unpublished_idx`, which an idle outbox keeps empty.
 */
const OUTBOX_HORIZON_ARM = `
union all
select null, null, null, null, null, null, null, null, null, null, null, null, null, null,
       null,
       (select (extract(epoch from (min(o.claimed_at) - now())) * 1000)::bigint + $2::bigint
          from x_outbox o
         where o.published_at is null and o.claimed_at is not null)
 where not exists (select 1 from claimed)`;

export const SQL_OUTBOX_CLAIM = outboxClaimSql(false);

/**
 * `SQL_OUTBOX_CLAIM` plus its horizon (`OUTBOX_HORIZON_ARM`), sent only to a relay that listens
 * (`OutboxStore.claim`'s `onEmpty`): an idle one, which rests on it instead of polling.
 */
export const SQL_OUTBOX_CLAIM_IDLE = outboxClaimSql(true);

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

/**
 * `SQL_OUTBOX_MARK_PUBLISHED` for a published batch: the same two fences, row for row, so a
 * lapsed claimant's batch mark retires none of the rows a newer claimant now holds.
 */
export const SQL_OUTBOX_MARK_PUBLISHED_MANY = `
update x_outbox set published_at = to_timestamp($2 / 1000.0)
 where id = any($1::uuid[]) and published_at is null and claimed_by = $3
`.trim();

/**
 * The job a staged row's publish made, by the id the two share. Read when `SQL_ENQUEUE` inserted
 * nothing for a request that named its id: the answer is that publish, repeated.
 */
export const SQL_OUTBOX_PUBLISHED_JOB = `
select id, run_id from x_jobs where id = $1
`.trim();

export const SQL_OUTBOX_PENDING_COUNT = `
select count(*)::bigint as pending from x_outbox where published_at is null
`.trim();
