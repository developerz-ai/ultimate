// Single responsibility: a `DbClient` as `@ultimat3/core`'s structural `PgExecutor` — the
// `query(text, values)` seam the jobs queue, the outbox, the idempotency, notify and MCP
// confirmation stores take. The ONE builder: the boot and an app both build theirs here.

import type { PgExecutor } from '@ultimat3/core';
import { type DbClient, db } from './client';
import type { SqlFragment } from './sql';

/**
 * The client is resolved per STATEMENT, never at the call. Default `db`: the installed client, so
 * an executor declared at module scope — before boot installs one — still reaches the boot's, and
 * inside `withTransaction` the transaction's own connection, so a store's row commits or rolls
 * back with the business rows. Pass `() => client` for a store that must stay on one pool whatever
 * transaction is open (the boot's queue and idempotency reservations).
 *
 * The fragment is assembled by hand rather than through `sql`` `: a store hands over `$1..$n`
 * text it wrote itself plus already-bound values, so there is nothing to interpolate or guard.
 */
export function dbExecutor(client: () => DbClient = db): PgExecutor {
  return {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      client().query<R>({ text, values } satisfies SqlFragment),
  };
}
