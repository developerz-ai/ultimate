// Single responsibility: `history(db.postsHistory, id)` — one row's recorded versions, oldest first,
// numbered from 1 — and `{ limit }`, the newest of them. A read of the history table like any other
// (tenant-scoped by the repository, keyset-batched), ordered by `history-order.ts`.

import { type HistoryRecord, type HistoryVersion, orderVersions } from './history-order';
import { assertFinitePageSize, MAX_PAGE_SIZE } from './plan';
import type { ReadBuilder } from './query';
import { getEntity } from './registry';

export interface HistoryReadOptions {
  /** The newest `limit` versions only, read newest-first and stopped there; at most `MAX_PAGE_SIZE`. */
  readonly limit?: number | undefined;
}

/** The parent's counting columns (physical names), read off its description; none if unknown. */
const ignoredOf = (historyName: string): ReadonlySet<string> => {
  const parent = getEntity(historyName)?.core?.$historyOf;
  const core = parent === undefined || parent === null ? undefined : getEntity(parent)?.core;
  return new Set(core?.$describe().history?.ignore ?? []);
};

/**
 * The newest rows by `at`, at least `limit` of them and every one sharing the boundary instant —
 * a transaction's writes share `now()`, so a tie is never cut and the chain decides inside it.
 */
async function newest(
  table: ReadBuilder<HistoryRecord>,
  id: string,
  limit: number,
): Promise<HistoryRecord[]> {
  const rows: HistoryRecord[] = [];
  const batches = table
    .where({ rowId: id })
    .orderBy('at', 'desc')
    .inBatches(Math.min(MAX_PAGE_SIZE, limit + 1));
  for await (const batch of batches) {
    for (const row of batch) {
      const boundary = rows[limit - 1];
      if (boundary !== undefined && row.at.getTime() < boundary.at.getTime()) return rows;
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Every recorded version of the row `id`, oldest first. `table` is the history entity's table —
 * `database({ posts, postsHistory: posts.$history })` — so the read is that table's: scoped to the
 * acting tenant (another tenant's row reads back as `[]`), indexed on `(tenant, row_id, at)`. Who
 * may read it is decided by the query or action that calls this, by its policy.
 *
 * `{ limit: n }`: the newest `n` versions, oldest first, each numbered as the whole history numbers
 * it (one `count` beside the read). The window is chosen by `at`, every tie at its edge included:
 * a transaction that BEGAN before the window and committed inside it can sit outside it.
 */
export async function history(
  table: ReadBuilder<HistoryRecord>,
  id: string,
  options: HistoryReadOptions = {},
): Promise<readonly HistoryVersion[]> {
  const ignored = ignoredOf(table.plan().entity);
  const { limit } = options;
  if (limit === undefined) {
    const rows: HistoryRecord[] = [];
    const all = table.where({ rowId: id }).orderBy('at').inBatches(MAX_PAGE_SIZE);
    for await (const batch of all) rows.push(...batch);
    return orderVersions(rows, ignored);
  }
  // A bad limit is the page refusal `.limit()` answers — `0` would otherwise read every version.
  const entity = table.plan().entity;
  const [window, total] = await Promise.all([
    newest(table, id, assertFinitePageSize(entity, limit)),
    table.where({ rowId: id }).count(),
  ]);
  const ordered = orderVersions(window, ignored);
  const offset = total - ordered.length;
  return ordered
    .slice(Math.max(0, ordered.length - limit))
    .map((row) => ({ ...row, version: row.version + offset }));
}
