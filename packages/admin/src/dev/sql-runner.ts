// The `/_x` DB panel's statement, RUN: inside `readOnlyQuery` — its own `BEGIN READ ONLY`
// transaction, a statement timeout and a row ceiling — never through the app's plain `db.query`.
// A host wires `runSql: readOnlySql(client)`; the guard upstream decides what reaches it.

import { type DbClient, readOnlyQuery } from '@ultimat3/db';
import type { SqlResult } from './facts';

/**
 * The most rows the panel asks the server for. It draws a grid, not an export: a cursor fetches
 * this many and the rest of a `select * from events` is never materialised in the dev process.
 */
export const DEV_SQL_MAX_ROWS = 500;

/**
 * The runner a `/_x` host hands the DB panel. `assertReadOnlyQuery` (`panel-db.ts`) is the parse
 * guard; this is the SERVER saying no: a statement the guard let through that writes, locks or
 * runs away still meets a read-only transaction that always rolls back, with the app's own
 * credentials and no way to commit. Columns are the first row's keys — the driver hands objects.
 */
export function readOnlySql(client: DbClient): (sql: string) => Promise<SqlResult> {
  return async (sql) => {
    const started = performance.now();
    const { rows } = await readOnlyQuery<Readonly<Record<string, unknown>>>(sql, {
      client,
      maxRows: DEV_SQL_MAX_ROWS,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const columns = Object.keys(rows[0] ?? {});
    return { columns, rows: rows.map((row) => columns.map((column) => row[column])), elapsedMs };
  };
}
