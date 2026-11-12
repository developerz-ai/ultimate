// Single responsibility: an hnsw search that returns `k` rows for a small tenant. pgvector applies
// `where` AFTER the index scan, so a plain scan hands back the `ef_search` nearest rows of the
// whole table and a tenant holding 0.5% of it gets fewer than `k` — usually none. Each search runs
// in a read transaction whose first statements widen the scan, and the setting ends with it.

import type { DbClient, SqlFragment } from '@ultimat3/db';
import { currentTx, setLocal, sql, withReadTransaction } from '@ultimat3/db';

/** pgvector's ceiling on `hnsw.ef_search`. */
const EF_SEARCH_MAX = 1_000;
/** pgvector's default: never lowered below it. */
const EF_SEARCH_DEFAULT = 40;

/**
 * What each setting reads when this backend has not loaded pgvector yet (`current_setting` is
 * `null` then) — restored as itself, since an empty string is no value of either.
 */
const DEFAULTS = new Map([
  ['hnsw.iterative_scan', 'off'],
  ['hnsw.ef_search', String(EF_SEARCH_DEFAULT)],
]);

interface AppliedRow {
  readonly name: string | null;
  readonly value: string | null;
  readonly prior: string | null;
}

/**
 * Which setting to widen, before the search: `hnsw.iterative_scan = relaxed_order` on pgvector
 * ≥ 0.8 — the scan continues until `k` rows pass the filter — else `hnsw.ef_search = max(40,
 * wanted × 10)`. The version is the server's (`pg_extension`), read in the same statement as the
 * `prior` value, for a search that joined a caller's transaction to put back. The write itself is
 * `setLocal`'s: `@ultimat3/db`'s `local-settings.ts` is the framework's one `set_config` sender.
 */
export function hnswRecallSql(wanted: number): SqlFragment {
  const ef = String(Math.min(EF_SEARCH_MAX, Math.max(EF_SEARCH_DEFAULT, wanted * 10)));
  return sql`select setting.name, setting.value, current_setting(setting.name, true) as prior
from (
  select case when iterative then 'hnsw.iterative_scan' else 'hnsw.ef_search' end as name,
    case when iterative then 'relaxed_order' else ${ef} end as value
  from (
    select string_to_array(split_part(extversion, '-', 1), '.')::int[] >= '{0,8}'::int[] as iterative
    from pg_extension where extname = 'vector'
  ) version
) setting`;
}

/**
 * `read` on `client`, with the recall setting in place. Outside a transaction it opens a read-only
 * one, so the setting cannot outlive the search on a pooled connection. Inside one it joins it and
 * puts the prior value back, so the rest of the caller's transaction is untouched. A store pinned
 * to a client OTHER than the open transaction's reads as it always did, outside it, unwidened.
 */
export async function withHnswRecall<T>(
  client: DbClient | undefined,
  wanted: number,
  read: (on: DbClient) => Promise<T>,
): Promise<T> {
  const open = currentTx();
  if (open !== undefined && client !== undefined && client !== open.origin) return read(client);
  return withReadTransaction(
    async (tx) => {
      const [applied] = await tx.query<AppliedRow>(hnswRecallSql(wanted));
      const name = applied?.name ?? undefined;
      if (name !== undefined && applied?.value != null)
        await setLocal(tx, { [name]: applied.value });
      const prior = applied?.prior ?? (name === undefined ? undefined : DEFAULTS.get(name));
      if (open === undefined || name === undefined || prior === undefined) return read(tx);
      const restore = { [name]: prior };
      try {
        return await read(tx);
      } finally {
        await setLocal(tx, restore).catch(() => undefined);
      }
    },
    { client },
  );
}
