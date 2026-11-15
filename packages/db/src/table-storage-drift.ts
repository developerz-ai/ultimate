// Single responsibility: a `tableStorage()` declaration against the catalog — what `pg_class` holds
// for each declared parameter, every difference with the statement that converges it. Split from
// `table-storage.ts`, which declares and renders.

import type { DbClient } from './client';
import { psqlCommand } from './dependent-view';
import { sql } from './sql';
import type { AutovacuumParameter } from './table-autovacuum';
import { autovacuumEntries, reloption } from './table-autovacuum';
import type { TableStorage } from './table-storage';
import { storageAlters } from './table-storage';

/** What the catalog holds for one table — `CatalogTable` satisfies it. `options` is `reloptions` joined. */
export interface LiveTableStorage {
  readonly unlogged: boolean;
  readonly options: string | null;
}

export interface TableStorageDifference {
  readonly table: string;
  readonly parameter: 'table' | 'persistence' | 'fillfactor' | AutovacuumParameter;
  readonly declared: string;
  readonly live: string;
  /** The statement that converges it, as SQL — `null` for a missing table, which `x db migrate` creates. */
  readonly statement: string | null;
  /** A command that runs as written: `psql … -c '<statement>'`, or `x db migrate`. */
  readonly fix: string;
}

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
  const fillfactor = reloption(live.options, 'fillfactor');
  // A number, as below: a hand-written `fillfactor = 080` is held as that text.
  if (storage.fillfactor !== undefined && Number(fillfactor ?? Number.NaN) !== storage.fillfactor) {
    differences.push({
      table,
      parameter: 'fillfactor',
      declared: String(storage.fillfactor),
      live: fillfactor ?? 'default (100)',
      ...converge(alters.find((alter) => alter.includes('fillfactor'))),
    });
  }
  // Compared as numbers: the catalog keeps the text the alter was written with.
  for (const [parameter, value] of autovacuumEntries(storage.autovacuum)) {
    const held = reloption(live.options, parameter);
    if (held !== null && Number(held) === value) continue;
    differences.push({
      table,
      parameter,
      declared: String(value),
      live: held ?? 'default',
      ...converge(alters.find((alter) => alter.includes('autovacuum_'))),
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
