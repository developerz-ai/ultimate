// One database per test WORKER, reset between files — instead of one booted per test file.
//
// Booting an embedded Postgres (PGlite) from a migrated template costs 2.4-7 s of CPU on a
// 12-core box (measured, 64 MB template: 2.7-7.2 s cold, 2.4-2.9 s with the WASM module and fs
// bundle already compiled — the untar and the postgres start are the cost, not the compile). A
// suite that boots one per file pays that in every file: notificado.co's unit tier has 236 such
// files, ~700 s of CPU, which is most of its wall time at any width.
//
// Since 22.7 a worker runs many files in one process (no `--isolate`), so the database can outlive
// a file. `reusableDatabase(open)` opens it ONCE per worker, snapshots every table's rows and every
// sequence right after (the migrated template: reference data, seeded rows), and on each later
// acquire puts the data back to exactly that: TRUNCATE every table, re-insert the snapshot, reset
// the sequences — with triggers off for the duration (`session_replication_role = replica`), so an
// insert-only guard on an evidence table does not refuse the reset the way it refuses a test.
//
// What it does NOT undo: DDL a test ran (a table it created stays; one it dropped stays gone). A
// test that changes the schema opens its own database.

import type { DbClient, SqlFragment } from '@ultimat3/db';
import { identifier, raw, sql } from '@ultimat3/db';

interface TableSnapshot {
  readonly table: string;
  /** Insertable columns — generated ones are recomputed, never written. */
  readonly columns: readonly string[];
  /** The rows as JSON text, or null for an empty table. */
  readonly rows: string | null;
}

interface SequenceSnapshot {
  readonly sequence: string;
  readonly lastValue: string | null;
}

export interface DatabaseSnapshot {
  readonly tables: readonly TableSnapshot[];
  readonly sequences: readonly SequenceSnapshot[];
}

const list = (names: readonly string[]): SqlFragment =>
  raw(names.map((name) => `"${name.replaceAll('"', '""')}"`).join(', '));

/** Every public table's rows and every public sequence's position, as they are now. */
export async function snapshotDatabase(client: DbClient): Promise<DatabaseSnapshot> {
  const tables = await client.query<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  const snapshots: TableSnapshot[] = [];
  for (const { table_name: table } of tables) {
    const columns = (
      await client.query<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' order by ordinal_position`,
      )
    ).map((row) => row.column_name);
    const row = await client.one<{ rows: string | null }>(
      sql`select json_agg(t)::text as rows from ${identifier(table)} t`,
    );
    snapshots.push({ table, columns, rows: row?.rows ?? null });
  }
  const sequences = await client.query<{ sequencename: string; last_value: string | null }>(
    sql`select sequencename, last_value::text as last_value from pg_sequences where schemaname = 'public'`,
  );
  return {
    tables: snapshots,
    sequences: sequences.map((row) => ({ sequence: row.sequencename, lastValue: row.last_value })),
  };
}

/** Put every table's rows and every sequence back to `snapshot`. Triggers are off meanwhile. */
export async function restoreDatabase(client: DbClient, snapshot: DatabaseSnapshot): Promise<void> {
  const current = (
    await client.query<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )
  ).map((row) => row.table_name);
  await client.execute(raw('set session_replication_role = replica'));
  try {
    if (current.length > 0) {
      await client.execute(sql`truncate ${list(current)} restart identity cascade`);
    }
    for (const table of snapshot.tables) {
      if (table.rows === null || !current.includes(table.table)) continue;
      const columns = list(table.columns);
      await client.execute(
        sql`insert into ${identifier(table.table)} (${columns}) overriding system value select ${columns} from json_populate_recordset(null::${identifier(table.table)}, ${table.rows}::json)`,
      );
    }
    for (const { sequence, lastValue } of snapshot.sequences) {
      await client.execute(
        lastValue === null
          ? sql`select setval(${`"${sequence}"`}::regclass, 1, false)`
          : sql`select setval(${`"${sequence}"`}::regclass, ${lastValue}::bigint, true)`,
      );
    }
  } finally {
    await client.execute(raw('set session_replication_role = origin'));
  }
}

/**
 * `acquire()` answers the same client for the life of the worker process, with its data reset to
 * what it held right after `open()`. The first call opens and snapshots; each later one restores.
 * Never close what it hands out — the worker's exit does.
 */
export function reusableDatabase<C extends DbClient>(open: () => Promise<C>): () => Promise<C> {
  let opened: Promise<{ client: C; snapshot: DatabaseSnapshot }> | undefined;
  let first = true;
  return async () => {
    opened ??= (async () => {
      const client = await open();
      return { client, snapshot: await snapshotDatabase(client) };
    })();
    const { client, snapshot } = await opened;
    if (first) first = false;
    else await restoreDatabase(client, snapshot);
    return client;
  };
}
