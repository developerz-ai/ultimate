// Single responsibility: a framework-owned table's storage parameters (`fillfactor`, `unlogged`,
// `table-autovacuum.ts`' triggers) as ONE declared value — rendered into its `create table`,
// re-applied by idempotent `alter`s at framework-schema apply, compared against `pg_class` by drift.
//
// Before it, framework DDL was fixed strings and nothing could state either parameter.
//
// The API, as a framework package uses it (`@ultimat3/http`'s `x_rate_limit`, `@ultimat3/jobs`):
//
//   import { tableDdl, tableStorage } from '@ultimat3/db';
//   const RATE_LIMIT_STORAGE = tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true });
//   export const SQL_RATE_LIMIT_TABLE = `
//   ${tableDdl(RATE_LIMIT_STORAGE, `
//     key    text primary key,
//     tokens double precision not null`)}
//   drop index if exists x_rate_limit_updated_at_idx;
//   `;
//
//   tableStorageDrift(storage, catalogTable)          — pure: declared vs one `CatalogTable`
//   readTableStorageDrift(client, [storage, …])       — one `pg_class` read, every difference
//
// Both drift readers live in `table-storage-drift.ts`.

import { DbError } from './errors';
import type { TableAutovacuum } from './table-autovacuum';
import { autovacuumProblem, autovacuumSettings } from './table-autovacuum';

export interface TableStorageOptions {
  /** 10–100, Postgres' own range. Left out: the table's fillfactor is not this declaration's. */
  readonly fillfactor?: number;
  /** `true` unlogged, `false` logged (stated, e.g. a table that must survive a crash). Left out: neither. */
  readonly unlogged?: boolean;
  /** When autovacuum visits the table. Left out: Postgres' defaults, never judged. */
  readonly autovacuum?: TableAutovacuum;
}

export interface TableStorage {
  readonly table: string;
  readonly fillfactor: number | undefined;
  readonly unlogged: boolean | undefined;
  readonly autovacuum: TableAutovacuum | undefined;
}

/**
 * Bare lower-case names only: every framework table is spelled that way, the DDL constants splice
 * the name unquoted, and `framework-schema.test.ts` reads the created names back with that pattern.
 */
const FRAMEWORK_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * `X_SQL_UNSAFE`, the precedent `indexMethodInvalid` set: both values are SPLICED into DDL text —
 * `with (fillfactor = …)` takes no parameter — so an operand TypeScript never saw is an injection.
 */
const storageInvalid = (table: string, what: string): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `tableStorage(${JSON.stringify(table)}): ${what}`,
    fix: "tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true })   # a bare lower-case name, an integer fillfactor 10-100, autovacuum thresholds integers 0-2147483647 and scale factors 0-100",
    meta: { table },
  });

/** The declaration, validated once where it is made — a module constant, so a bad one fails at import. */
export function tableStorage(table: string, options: TableStorageOptions): TableStorage {
  if (!FRAMEWORK_NAME.test(table)) {
    throw storageInvalid(table, 'the table name is not a bare lower-case identifier');
  }
  const { fillfactor } = options;
  if (
    fillfactor !== undefined &&
    !(Number.isInteger(fillfactor) && fillfactor >= 10 && fillfactor <= 100)
  ) {
    throw storageInvalid(
      table,
      `fillfactor ${String(fillfactor)} is not an integer from 10 to 100`,
    );
  }
  const autovacuum = options.autovacuum;
  const problem = autovacuum === undefined ? undefined : autovacuumProblem(autovacuum);
  if (problem !== undefined) throw storageInvalid(table, problem);
  return Object.freeze({
    table,
    fillfactor,
    unlogged: options.unlogged,
    autovacuum: autovacuum === undefined ? undefined : Object.freeze({ ...autovacuum }),
  });
}

/**
 * The statements that bring an EXISTING table to the declaration — what `create … if not exists`
 * cannot, since it does nothing to a table that is there. Each is idempotent: `set (fillfactor)`
 * rewrites one `pg_class` row under `SHARE UPDATE EXCLUSIVE`, and `set unlogged` on a table that
 * already is one returns without a rewrite. That last one still takes `ACCESS EXCLUSIVE`, held to
 * the end of the apply transaction; the migrate role's `lock_timeout` bounds the wait.
 */
export function storageAlters(storage: TableStorage): readonly string[] {
  const alters: string[] = [];
  if (storage.fillfactor !== undefined) {
    alters.push(`alter table ${storage.table} set (fillfactor = ${String(storage.fillfactor)})`);
  }
  if (storage.unlogged !== undefined) {
    alters.push(`alter table ${storage.table} set ${storage.unlogged ? 'unlogged' : 'logged'}`);
  }
  const autovacuum = autovacuumSettings(storage.autovacuum);
  if (autovacuum.length > 0) {
    alters.push(`alter table ${storage.table} set (${autovacuum.join(', ')})`);
  }
  return alters;
}

/**
 * Leading newlines and trailing whitespace off, in one linear pass each: `trimEnd()` and an index
 * walk, never `/\s+$/g`, which retries at every space of an inner run (js/polynomial-redos).
 */
function columnBody(columns: string): string {
  let start = 0;
  while (columns.charCodeAt(start) === 10) start += 1;
  return columns.slice(start).trimEnd();
}

/**
 * `create [unlogged] table if not exists <name> (<columns>) [with (fillfactor = n)];` then the
 * alters, each `;`-terminated so the boot's split on `;` sees one statement apiece. `columns` is the
 * body between the parentheses, a fixed constant with no `;` in it, as every framework DDL is.
 */
export function tableDdl(storage: TableStorage, columns: string): string {
  const head = storage.unlogged === true ? 'create unlogged table' : 'create table';
  const settings = [
    ...(storage.fillfactor === undefined ? [] : [`fillfactor = ${String(storage.fillfactor)}`]),
    ...autovacuumSettings(storage.autovacuum),
  ];
  const options = settings.length === 0 ? '' : ` with (${settings.join(', ')})`;
  const create = `${head} if not exists ${storage.table} (\n${columnBody(columns)}\n)${options};`;
  return [create, ...storageAlters(storage).map((alter) => `${alter};`)].join('\n');
}
