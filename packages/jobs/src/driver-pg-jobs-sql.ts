// Every statement that returns a WHOLE `x_jobs` row, and the one column list they share. Apart
// from `driver-pg-sql.ts` because that file is at its size ceiling — the same split
// `driver-pg-ddl.ts` took — and re-exported from it, so no importer moved.
//
// They exist at all because `select *` was what four of them were: `PgExecutor` is an injected
// seam over any client that speaks `(text, values)`, and a client with no type map decodes
// `timestamptz` as TEXT. `toJobRecord` then reads `Number('2026-01-01 00:00:00+00')` — `NaN` for
// `runAt`, `createdAt` and `updatedAt`, printed by `x jobs ls`, `x jobs show` and `x jobs cancel`.
// `SQL_CLAIM` had always projected epoch ms; these are the reads that had opted out of it.

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

/** `run_at = now()` makes the requeued job due immediately; the attempt counter starts over. */
export const SQL_JOB_REQUEUE = `
update x_jobs
   set state = 'ready', attempt = 0, run_at = now(), updated_at = now()
 where id = $1
returning ${JOB_ROW_COLUMNS}
`.trim();
