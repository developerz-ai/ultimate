// The `/_x` DB panel's statement, RUN: inside `readOnlyQuery` — its own `BEGIN READ ONLY`
// transaction, a statement timeout, a row ceiling and the SELECT-only role — never through the
// app's plain `db.query`. A host wires `runSql: readOnlySql(client)`; the guard upstream decides
// what reaches it.

import { type DbClient, ensureReadOnlyRole, readOnlyQuery } from '@ultimat3/db';
import type { SqlResult } from './facts';

/**
 * The most rows the panel asks the server for. It draws a grid, not an export: a cursor fetches
 * this many and the rest of a `select * from events` is never materialised in the dev process.
 */
export const DEV_SQL_MAX_ROWS = 500;

/**
 * The runner a `/_x` host hands the DB panel. `assertReadOnlyQuery` (`panel-db.ts`) is the parse
 * guard; this is the SERVER saying no: a statement the guard let through that writes, locks or
 * runs away still meets a read-only transaction that always rolls back, run as the role
 * `ensureReadOnlyRole` grants SELECT and nothing else — the layer MCP's `db.query` already had.
 * The app's own credentials are often a dev superuser, so without it a parse-guard miss met one
 * layer, not two. Columns are the first row's keys — the driver hands objects.
 *
 * The role's DDL runs until it succeeds, then never again for this runner. `ensureReadOnlyRole`
 * never throws: a database that refuses `CREATE ROLE` answers `null`, the read runs without that
 * layer, and the next statement asks again.
 */
export function readOnlySql(client: DbClient): (sql: string) => Promise<SqlResult> {
  let role: Promise<string | null> | undefined;
  return async (sql) => {
    role ??= ensureReadOnlyRole(client);
    const assumed = await role;
    // `null` is not an answer to keep: a lost race (`x mcp serve` creating the role at the same
    // moment) reads exactly like a refusal, and caching it ran every later statement without the
    // layer. Asked again on the next statement; a role that exists is kept.
    if (assumed === null) role = undefined;
    // After the role: the panel times the statement, not the first call's one-off DDL.
    const started = performance.now();
    const { rows } = await readOnlyQuery<Readonly<Record<string, unknown>>>(sql, {
      client,
      maxRows: DEV_SQL_MAX_ROWS,
      role: assumed,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const columns = Object.keys(rows[0] ?? {});
    return { columns, rows: rows.map((row) => columns.map((column) => row[column])), elapsedMs };
  };
}
