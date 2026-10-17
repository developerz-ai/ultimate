// The batch loop every row-count retention target shares: one counted DELETE per `batchSize` rows,
// repeated until a batch comes back short or `maxBatches` ran. A backlog of months is drained over
// several passes rather than in one statement that locks every row it will delete.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';

/** Rows per DELETE. Small enough that one statement holds its row locks for milliseconds. */
export const DEFAULT_RETENTION_BATCH = 1_000;
/** Statements per pass. An hourly pass clears 50,000 rows, and a backlog drains over hours. */
export const DEFAULT_RETENTION_MAX_BATCHES = 50;

export interface PurgeBatching {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/** The two bounds, screened once at construction under the factory's name. */
export function purgeBatching(
  subject: string,
  options: PurgeBatching,
): { readonly batch: number; readonly rounds: number } {
  return {
    batch: finiteCount(subject, 'batchSize', options.batchSize ?? DEFAULT_RETENTION_BATCH, 1),
    rounds: finiteCount(
      subject,
      'maxBatches',
      options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES,
      1,
    ),
  };
}

/**
 * Run `sql` until it removes fewer than `batch` rows or `rounds` statements ran, and answer the
 * total. `sql` answers one row `{ removed }` and takes `params` with the batch size appended last.
 */
export async function purgeInBatches(
  executor: PgExecutor,
  sql: string,
  params: readonly unknown[],
  bounds: { readonly batch: number; readonly rounds: number },
): Promise<number> {
  let removed = 0;
  for (let round = 0; round < bounds.rounds; round += 1) {
    const rows = await executor.query<{ removed: number | string }>(sql, [...params, bounds.batch]);
    const count = Number(rows[0]?.removed ?? 0);
    removed += count;
    if (count < bounds.batch) break;
  }
  return removed;
}
