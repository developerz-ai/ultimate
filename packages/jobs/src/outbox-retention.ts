// Retention for PUBLISHED `x_outbox` rows, as one `PurgeTarget` the boot's hourly `purge()` sweeps.
// A published row's work is over — the job it staged is in `x_jobs` — and nothing deleted it, so
// the table kept every enqueue a transaction ever staged, `mail.send`'s address and body included.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { PurgeTarget } from './purge';
import { type PurgeBatching, purgeBatching, purgeInBatches } from './purge-batches';

/**
 * One batch, counted. Only `published_at is not null`: an unpublished row is a job the relay has
 * not handed over yet, and deleting it is losing that job. The `x_jobs` sweep vetoes a job whose
 * outbox row is still unpublished; this one never touches such a row, so the two cannot disagree.
 *
 * The cutoff is the JOB's clock (`$1`): `SQL_OUTBOX_MARK_PUBLISHED` stamps `published_at` from the
 * relay's clock, so measuring it against the server's `now()` is the two-clock mismatch
 * `PurgeTarget.purgeExpired` warns about.
 */
export const SQL_OUTBOX_RETENTION_BATCH = `
with doomed as (
  select id from x_outbox
   where published_at is not null
     and published_at < to_timestamp(($1::bigint - $2::bigint) / 1000.0)
   order by published_at
   limit $3
     for update skip locked
), gone as (
  delete from x_outbox where id in (select id from doomed) returning 1
)
select count(*)::int as removed from gone
`.trim();

/**
 * The window is REQUIRED: its default is `app.config.ts`'s (`jobs.outboxRetentionMs`, in
 * `@ultimat3/core`), for the reason `JobsRetentionOptions` gives.
 */
export interface OutboxRetentionOptions extends PurgeBatching {
  readonly executor: PgExecutor;
  /** Age of `published_at` past which a published row goes. */
  readonly publishedRetentionMs: number;
}

const SUBJECT = 'outboxPurgeTarget';

/** `x_outbox` as a purge target, batched (`purge-batches.ts`). */
export function outboxPurgeTarget(options: OutboxRetentionOptions): PurgeTarget {
  const window = finiteCount(SUBJECT, 'publishedRetentionMs', options.publishedRetentionMs, 1);
  const bounds = purgeBatching(SUBJECT, options);
  return {
    name: 'x_outbox',
    purgeExpired: (nowMs: number): Promise<number> =>
      purgeInBatches(
        options.executor,
        SQL_OUTBOX_RETENTION_BATCH,
        [Math.trunc(nowMs), window],
        bounds,
      ),
  };
}
