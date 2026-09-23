// Every statement returning a WHOLE `x_jobs` row, and the one column list they share. They ask
// Postgres for epoch ms because `select *` left the decoding to the client's type map: one with
// none decodes `timestamptz` as TEXT, so `toJobRecord` read `Number('2026-01-01 00:00:00+00')`
// and `x jobs ls` / `show` / `cancel` printed `NaN` for every timestamp.

/**
 * The `JobRow` shape as a projection. Asking Postgres for epoch ms is what makes the decoding
 * independent of the client's type map — never `select *`, whose correctness is the driver's
 * opinion about `timestamptz` rather than this statement's.
 */
export const JOB_ROW_COLUMNS = `id, name, queue, input, idempotency_key, run_id, attempt,
       max_attempts, state, tenant_id, last_error, claimed_by,
       traceparent, enqueued_by,
       (extract(epoch from run_at)     * 1000)::bigint as run_at,
       (extract(epoch from visible_at) * 1000)::bigint as visible_at,
       (extract(epoch from created_at) * 1000)::bigint as created_at,
       (extract(epoch from updated_at) * 1000)::bigint as updated_at`;

export const SQL_JOB_GET = `
select ${JOB_ROW_COLUMNS}
  from x_jobs where id = $1
`.trim();

export const SQL_JOB_LIST = `
select ${JOB_ROW_COLUMNS}
  from x_jobs
 where ($1::text is null or queue = $1)
   and ($2::text is null or name  = $2)
   and ($3::text is null or state = $3)
 order by created_at desc
 limit $4
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
 * or raced to live in between.
 */
export const SQL_JOB_REQUEUE = `
update x_jobs
   set state = 'ready', attempt = 0, run_at = now(), updated_at = now(),
       claimed_by = null, visible_at = null
 where id = $1 and state in ('dead', 'cancelled', 'done', 'failed')
returning ${JOB_ROW_COLUMNS}
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
