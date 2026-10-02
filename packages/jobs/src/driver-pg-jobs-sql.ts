// Every statement returning a WHOLE `x_jobs` row, and the one column list they share. They ask
// Postgres for epoch ms because `select *` left the decoding to the client's type map: one with
// none decodes `timestamptz` as TEXT, so `toJobRecord` read `Number('2026-01-01 00:00:00+00')`
// and `x jobs ls` / `show` / `cancel` printed `NaN` for every timestamp.

import { JOBS_WAKE_CHANNEL } from './driver-pg-wake-sql';

/**
 * The `JobRow` shape as a projection. Asking Postgres for epoch ms is what makes the decoding
 * independent of the client's type map — never `select *`, whose correctness is the driver's
 * opinion about `timestamptz` rather than this statement's.
 */
export const JOB_ROW_COLUMNS = `id, name, queue, input, idempotency_key, run_id, attempt,
       max_attempts, state, tenant_id, last_error, last_error_stack, claimed_by, claims,
       traceparent, enqueued_by, progress,
       (extract(epoch from run_at)     * 1000)::bigint as run_at,
       (extract(epoch from visible_at) * 1000)::bigint as visible_at,
       (extract(epoch from created_at) * 1000)::bigint as created_at,
       (extract(epoch from updated_at) * 1000)::bigint as updated_at`;

/** `JOB_ROW_COLUMNS` by their output names — what a statement reading a derived table selects. */
const JOB_ROW_NAMES = `id, name, queue, input, idempotency_key, run_id, attempt, max_attempts,
       state, tenant_id, last_error, last_error_stack, claimed_by, claims, traceparent,
       enqueued_by, progress, run_at, visible_at, created_at, updated_at`;

export const SQL_JOB_GET = `
select ${JOB_ROW_COLUMNS}
  from x_jobs where id = $1
`.trim();

/**
 * The predicates a page shares, whichever way it reads. $1 queue, $2 name, $3 state, $5 id prefix,
 * $6 created from (ms), $7 created to (ms), $10 tenant. The prefix is compared, never `like`d: a
 * `_` or `%` in it is a character, as `startsWith` reads it in the memory driver.
 */
const LIST_MATCH = `($1::text is null or queue = $1)
   and ($2::text is null or name  = $2)
   and ($3::text is null or state = $3)
   and ($5::text is null or left(id::text, length($5::text)) = $5::text)
   and ($6::bigint is null or created_at >= to_timestamp($6::bigint / 1000.0))
   and ($7::bigint is null or created_at <  to_timestamp($7::bigint / 1000.0))
   and ($10::text is null or tenant_id = $10)`;

/**
 * One page, newest first, sought by KEYSET. `(created_at, id) < (cursor)` is a row comparison the
 * `x_jobs_created_idx` range answers directly; an offset would re-read every row before it and
 * shift under an insert.
 *
 * The cursor carries the last row's `createdAt` in epoch MS, and the column holds microseconds —
 * so the seek reads the cursor row's own `created_at` by id rather than trusting a rounded value,
 * which would skip or repeat its millisecond-mates. A cursor row deleted mid-walk falls back to
 * the millisecond after it: rows of that one millisecond may then repeat, and none is skipped.
 *
 * `LIST_MATCH`'s parameters, plus $4 limit, $8 cursor createdAt (ms), $9 cursor id.
 */
export const SQL_JOB_LIST = `
select ${JOB_ROW_COLUMNS}
  from x_jobs
 where ${LIST_MATCH}
   and ($9::uuid is null or (created_at, id) < (
         coalesce(
           (select c.created_at from x_jobs c where c.id = $9::uuid),
           to_timestamp(($8::bigint + 1) / 1000.0)
         ),
         $9::uuid
       ))
 order by created_at desc, id desc
 limit $4
`.trim();

/**
 * The page BEFORE a cursor: the `limit` rows nearest it on the newer side — read oldest first so
 * `limit` keeps the nearest, then turned newest first like every page. The same parameters as
 * `SQL_JOB_LIST`, $8/$9 being the first row of the page the reader is leaving. A cursor row
 * deleted meanwhile falls back to its millisecond: a row of it may repeat, none is skipped.
 */
export const SQL_JOB_LIST_BEFORE = `
select ${JOB_ROW_NAMES} from (
  select ${JOB_ROW_COLUMNS}
    from x_jobs
   where ${LIST_MATCH}
     and (created_at, id) > (
           coalesce(
             (select c.created_at from x_jobs c where c.id = $9::uuid),
             to_timestamp($8::bigint / 1000.0)
           ),
           $9::uuid
         )
   order by created_at asc, id asc
   limit $4
) page
 order by created_at desc, id desc
`.trim();

export const SQL_JOB_DEAD_LETTERS = `
select ${JOB_ROW_COLUMNS}
  from x_jobs where state = 'dead' order by updated_at desc limit $1
`.trim();

/**
 * `run_at = now()` makes the requeued job due immediately; the attempt counter starts over. Fenced
 * to FINISHED states and releasing the claim: requeueing a running row left `claimed_by` set with
 * state `ready`, and a second worker claimed it — the job ran twice. `REQUEUEABLE_STATES`
 * (`driver.ts`) is the same set; a row this matches nothing for was refused before it was sent,
 * or raced to live in between. `woke` announces the row in the statement that made it claimable
 * (`driver-pg-wake-sql.ts`): `x jobs retry` is a job starting now, not at an idle worker's poll.
 */
export const SQL_JOB_REQUEUE = `
update x_jobs
   set state = 'ready', attempt = 0, run_at = now(), updated_at = now(),
       claimed_by = null, visible_at = null
 where id = $1 and state in ('dead', 'cancelled', 'done', 'failed')
returning ${JOB_ROW_COLUMNS},
          pg_notify('${JOBS_WAKE_CHANNEL}', queue)::text as woke
`.trim();

/**
 * The LIVE row holding a requeued row's key, if any — `x_jobs_name_tenant_idempotency_live_idx`'s
 * predicate, read before the update so the answer is `X_JOB_DUPLICATE` rather than a raw 23505.
 */
export const SQL_JOB_LIVE_HOLDER = `
select id from x_jobs
 where name = $1 and coalesce(tenant_id, '') = coalesce($2, '') and idempotency_key = $3
   and id <> $4 and state in ('ready', 'delayed', 'running', 'suspended')
 limit 1
`.trim();

/**
 * "From that step onward": the step `fromStep` names and every step that started AFTER it.
 * Deleting the named step alone left later steps replaying results computed from the old run.
 * Strictly after, plus the step itself: a step sharing the target's millisecond is not provably
 * later, and re-running an EARLIER step — the charge before the receipt — is the worse mistake.
 */
export const SQL_STEPS_FROM = `
delete from x_job_steps
 where run_id = $1
   and (name = $2
        or started_at > (select started_at from x_job_steps where run_id = $1 and name = $2))
`.trim();
