// Single responsibility: prove the live schema and the migration ledger agree. Drift is the
// failure an agent creates most often — it edits a table by hand, the next deploy diverges, and
// nothing complains until production. The rendered `X_DB_DRIFT` output is byte-for-byte pinned
// by the framework contract; `x verify` fails on it and `--json` carries every difference.

import { baseClient, type DbClient } from './client';
import { DbError } from './errors';
import { findTable, introspect, type SchemaDescription, type TableDescription } from './introspect';
import { type LedgerRow, type Migration, readLedger } from './migrate';

export type DriftKind =
  | 'unexpected-column'
  | 'missing-column'
  | 'unexpected-table'
  | 'missing-table';

export interface DriftDifference {
  readonly kind: DriftKind;
  readonly table: string;
  readonly column: string | null;
  readonly cause: string;
  readonly fix: string;
}

export interface DriftReport {
  readonly ok: boolean;
  readonly differences: readonly DriftDifference[];
}

function unexpectedColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'unexpected-column',
    table,
    column,
    // Pinned by the contract. Do not reword without changing docs/errors/X_DB_DRIFT.
    cause: `table "${table}" has column "${column}" not present in any migration`,
    fix: `x db gen "add ${column}"`,
  };
}

function missingColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'missing-column',
    table,
    column,
    cause: `table "${table}" is missing column "${column}" that migrations declare`,
    fix: 'x db migrate',
  };
}

function unexpectedTable(table: string): DriftDifference {
  return {
    kind: 'unexpected-table',
    table,
    column: null,
    cause: `table "${table}" is not present in any migration`,
    fix: `x db gen "add ${table}"`,
  };
}

function missingTable(table: string): DriftDifference {
  return {
    kind: 'missing-table',
    table,
    column: null,
    cause: `table "${table}" is declared by migrations but does not exist`,
    fix: 'x db migrate',
  };
}

function compareTable(live: TableDescription, expected: TableDescription): DriftDifference[] {
  const differences: DriftDifference[] = [];
  const expectedColumns = new Set(expected.columns.map((column) => column.name));
  const liveColumns = new Set(live.columns.map((column) => column.name));
  for (const column of live.columns) {
    if (expectedColumns.has(column.name)) continue;
    differences.push(unexpectedColumn(live.name, column.name));
  }
  for (const column of expected.columns) {
    if (!liveColumns.has(column.name)) differences.push(missingColumn(live.name, column.name));
  }
  return differences;
}

/** Pure and total: the same inputs always produce the same ordered report. */
export function diffSchema(live: SchemaDescription, expected: SchemaDescription): DriftReport {
  const differences: DriftDifference[] = [];
  for (const table of live.tables) {
    const counterpart = findTable(expected, table.name);
    if (counterpart === undefined) differences.push(unexpectedTable(table.name));
    else differences.push(...compareTable(table, counterpart));
  }
  for (const table of expected.tables) {
    if (findTable(live, table.name) === undefined) differences.push(missingTable(table.name));
  }
  differences.sort((a, b) => {
    if (a.table !== b.table) return a.table < b.table ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return (a.column ?? '') < (b.column ?? '') ? -1 : 1;
  });
  return { ok: differences.length === 0, differences };
}

export function driftError(difference: DriftDifference): DbError {
  return new DbError({
    code: 'X_DB_DRIFT',
    cause: difference.cause,
    fix: difference.fix,
    meta: { kind: difference.kind, table: difference.table, column: difference.column },
  });
}

/** Throws the first difference. `x verify` calls this; `x db drift --json` reads the report. */
export function assertNoDrift(report: DriftReport): void {
  const first = report.differences[0];
  if (first !== undefined) throw driftError(first);
}

/**
 * The schema the migration files themselves declare, ledger or no ledger. Each generated
 * migration carries the snapshot it leaves behind, so the newest one with a snapshot is the
 * claim — no SQL is re-parsed.
 *
 * This is what `x db gen` diffs the app's entities against, and why generating a migration needs
 * no database: the previous migration already wrote down what it left behind.
 */
export function declaredSchema(migrations: readonly Migration[]): SchemaDescription {
  const snapshots = [...migrations]
    .filter((migration) => migration.snapshot !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return snapshots[snapshots.length - 1]?.snapshot ?? { tables: [] };
}

/**
 * The schema migrations claim to have *applied* — `declaredSchema` over the ledger's own subset,
 * never a second reading of the same snapshots. Generation asks "what have we written down" and
 * drift asks "what does this database owe us"; two answers, one implementation, so a snapshot can
 * never mean one thing to `x db gen` and another to `x verify`.
 */
export function expectedSchema(
  migrations: readonly Migration[],
  ledger: readonly LedgerRow[],
): SchemaDescription {
  const applied = new Set(ledger.map((row) => row.id));
  return declaredSchema(migrations.filter((migration) => applied.has(migration.id)));
}

/**
 * Framework bookkeeping is not app schema. The ledger, the job queue's tables, the outbox and
 * every `@ultimat3/auth` table are created by `create table if not exists` at boot — no migration
 * declares them and no snapshot carries them, so each one reads as `unexpected-table` against a
 * schema that is in fact correct. The `x_` prefix is the convention every framework table already
 * follows, so a table a future package adds needs no second list here.
 *
 * `introspect()` keeps its own narrower default (`x_migrations` alone) on purpose: the admin
 * dashboard's schema view and the MCP `schema.describe` tool legitimately show `x_users`. Only
 * drift wants the whole namespace gone, so only drift declares it.
 */
export const FRAMEWORK_TABLE_PREFIX = 'x_';

/** The live schema minus framework bookkeeping — what a migration snapshot can be compared to. */
export function appTables(live: SchemaDescription): SchemaDescription {
  return { tables: live.tables.filter((t) => !t.name.startsWith(FRAMEWORK_TABLE_PREFIX)) };
}

export interface DriftOptions {
  readonly migrations: readonly Migration[];
  readonly client?: DbClient | undefined;
  readonly schema?: string | undefined;
}

/**
 * **The post-migrate verification**: the live database against the ledger it just wrote. This is
 * the one drift question that needs a database, so it is asked where one is open — `runMigrations`
 * in `@ultimat3/cli`, which is `x db migrate`, `x db reset` and `ROLE=migrate` alike.
 *
 * The other drift question — "the entity source was edited and no migration recorded it" — needs
 * no database and is `x verify`'s `drift` step (`checkSourceDrift`, `@ultimat3/cli`). Two
 * conditions, two detectors, one `X_DB_DRIFT`; a check that opened a database in CI could not run
 * at all, and one that read files could not see a column added by hand.
 */
export async function checkDrift(options: DriftOptions): Promise<DriftReport> {
  const client = options.client ?? baseClient();
  const ledger = await readLedger(client);
  const live = await introspect({
    client,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  return diffSchema(appTables(live), expectedSchema(options.migrations, ledger));
}
