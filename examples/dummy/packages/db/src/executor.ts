/**
 * The process's Postgres as the structural `{ query(sql, params) }` a framework store takes — the
 * MCP confirmation store here, the same seam `@ultimat3/jobs` and `@ultimat3/notify` stores read.
 * `@ultimat3/cli` builds one for its own boot (`pgExecutorFor`) and exports none, so the app states
 * its own, over the same ambient client its entities read through: inside a transaction, the
 * transaction.
 */

import type { PgExecutor } from '@ultimat3/core';
import { db as client, type SqlFragment } from '@ultimat3/db';

export const executor: PgExecutor = {
  // `$1..$n` text the store wrote plus already-bound values: nothing to interpolate, nothing to guard.
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client().query<R>({ text, values } satisfies SqlFragment),
};
