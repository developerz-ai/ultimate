// Single responsibility: a framework-owned table's storage parameters (`fillfactor`, `unlogged`) as
// ONE declared value — rendered into its `create table`, re-applied to an existing table by
// idempotent `alter`s at framework-schema apply, and compared against `pg_class` by drift. Before
// it, framework DDL was fixed strings and nothing could state either parameter.
//
// The API, as a framework package uses it (`@ultimat3/http`'s `x_rate_limit`, `@ultimat3/jobs`):
//
//   import { createTableDdl, tableStorage } from '@ultimat3/db';
//   const RATE_LIMIT_STORAGE = tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true });
//   export const SQL_RATE_LIMIT_TABLE = `
//   ${createTableDdl(RATE_LIMIT_STORAGE, `
//     key    text primary key,
//     tokens double precision not null`)}
//   drop index if exists x_rate_limit_updated_at_idx;
//   `;
//
//   tableStorageDrift(storage, catalogTable)          — pure: declared vs one `CatalogTable`
//   readTableStorageDrift(client, [storage, …])       — one `pg_class` read, every difference

import type { DbClient } from './client';
import { psqlCommand } from './dependent-view';
import { DbError } from './errors';
import { sql } from './sql';

export interface TableStorageOptions {
  /** 10–100, Postgres' own range. Left out: the table's fillfactor is not this declaration's. */
  readonly fillfactor?: number;
  /** `true` unlogged, `false` logged (stated, e.g. a table that must survive a crash). Left out: neither. */
  readonly unlogged?: boolean;
}

export interface TableStorage {
  readonly table: string;
  readonly fillfactor: number | undefined;
  readonly unlogged: boolean | undefined;
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
    fix: "tableStorage('x_rate_limit', { fillfactor: 70, unlogged: true })   # a bare lower-case name, an integer fillfactor 10-100",
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
  return Object.freeze({ table, fillfactor, unlogged: options.unlogged });
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
  return alters;
}

/**
 * `create [unlogged] table if not exists <name> (<columns>) [with (fillfactor = n)];` then the
 * alters, each `;`-terminated so the boot's split on `;` sees one statement apiece. `columns` is the
 * body between the parentheses, a fixed constant with no `;` in it, as every framework DDL is.
 */
export function createTableDdl(storage: TableStorage, columns: string): string {
  const head = storage.unlogged === true ? 'create unlogged table' : 'create table';
  const options =
    storage.fillfactor === undefined ? '' : ` with (fillfactor = ${String(storage.fillfactor)})`;
  const create = `${head} if not exists ${storage.table} (\n${columns.replace(/^\n+|\s+$/g, '')}\n)${options};`;
  return [create, ...storageAlters(storage).map((alter) => `${alter};`)].join('\n');
}

/** What the catalog holds for one table — `CatalogTable` satisfies it. `options` is `reloptions` joined. */
export interface LiveTableStorage {
  readonly unlogged: boolean;
  readonly options: string | null;
}

export interface TableStorageDifference {
  readonly table: string;
  readonly parameter: 'table' | 'persistence' | 'fillfactor';
  readonly declared: string;
  readonly live: string;
  /** The statement that converges it, as SQL — `null` for a missing table, which `x db migrate` creates. */
  readonly statement: string | null;
  /** A command that runs as written: `psql … -c '<statement>'`, or `x db migrate`. */
  readonly fix: string;
}

/** `fillfactor=70, autovacuum_enabled=false` → `70`; absent → `null` (the server default, 100). */
const liveFillfactor = (options: string | null): string | null => {
  for (const option of (options ?? '').split(',')) {
    const [key, value] = option.trim().split('=');
    if (key === 'fillfactor' && value !== undefined) return value;
  }
  return null;
};

/**
 * The statement and the line that runs it. `psqlCommand` quotes it as one shell word, and the name
 * inside is the bare lower-case identifier `tableStorage` admitted, so nothing in it is shell-active.
 */
const converge = (alter: string | undefined): { statement: string; fix: string } => {
  const statement = `${alter ?? ''};`;
  return { statement, fix: `${psqlCommand(statement)}   # then x db migrate, which re-checks` };
};

/** Only what the declaration states is compared: a parameter left out is not this value's to judge. */
export function tableStorageDrift(
  storage: TableStorage,
  live: LiveTableStorage | undefined,
): readonly TableStorageDifference[] {
  const { table } = storage;
  if (live === undefined) {
    return [
      {
        table,
        parameter: 'table',
        declared: 'present',
        live: 'absent',
        statement: null,
        fix: 'x db migrate',
      },
    ];
  }
  const alters = storageAlters(storage);
  const differences: TableStorageDifference[] = [];
  if (storage.unlogged !== undefined && storage.unlogged !== live.unlogged) {
    const persistence = (unlogged: boolean): string => (unlogged ? 'unlogged' : 'logged');
    differences.push({
      table,
      parameter: 'persistence',
      declared: persistence(storage.unlogged),
      live: persistence(live.unlogged),
      ...converge(alters.find((alter) => /set (un)?logged$/.test(alter))),
    });
  }
  const fillfactor = liveFillfactor(live.options);
  if (storage.fillfactor !== undefined && String(storage.fillfactor) !== fillfactor) {
    differences.push({
      table,
      parameter: 'fillfactor',
      declared: String(storage.fillfactor),
      live: fillfactor ?? 'default (100)',
      ...converge(alters.find((alter) => alter.includes('fillfactor'))),
    });
  }
  return differences;
}

interface StorageRow {
  readonly name: string;
  readonly persistence: string;
  readonly options: string | null;
}

/**
 * Every declaration against the catalog, in ONE read — the reading `catalog-relations.ts` does
 * (`relpersistence`, `reloptions` joined by `, `), narrowed to the named tables of `current_schema()`.
 */
export async function readTableStorageDrift(
  client: DbClient,
  storages: readonly TableStorage[],
): Promise<readonly TableStorageDifference[]> {
  if (storages.length === 0) return [];
  const rows = await client.query<StorageRow>(sql`
    select c.relname as name, c.relpersistence as persistence,
           array_to_string(c.reloptions, ', ') as options
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and c.relkind in ('r', 'p')
       and c.relname = any(${storages.map((storage) => storage.table)}::text[])`);
  const live = new Map(rows.map((row) => [row.name, row]));
  return storages.flatMap((storage) => {
    const row = live.get(storage.table);
    return tableStorageDrift(
      storage,
      row === undefined ? undefined : { unlogged: row.persistence === 'u', options: row.options },
    );
  });
}
