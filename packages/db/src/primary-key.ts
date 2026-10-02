// Single responsibility: a table's PRIMARY KEY as DDL — the two statements that move one, the
// generator's arm that decides when they are due, and the refusal for a key another table still
// points at. `diffTable` had no arm for it, so a changed `primaryKey` wrote no statement while the
// snapshot beside it recorded the new key, and drift had no comparison to notice with.

import { assert } from '@ultimat3/core';
import type { EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import type { SchemaDescription, TableDescription } from './introspect';
import { MAX_IDENTIFIER_BYTES } from './invariant-ddl';
import { migrationIrreversible } from './migration-errors';
import { identifier } from './sql';

/**
 * `<table>_pkey` — what Postgres names the constraint an inline `primary key (…)` creates, which is
 * how `createTable` has always written one. Written out by name on every `add` here, so the name a
 * later migration drops is one a migration chose.
 *
 * Bounded in bytes: past 63 the server truncates the TABLE part to make room for `_pkey`, so the
 * name it holds is no longer this string and a `drop constraint` built from it would miss.
 */
export function primaryKeyName(table: string): string {
  const name = `${table}_pkey`;
  const bytes = new TextEncoder().encode(name).length;
  assert(
    bytes <= MAX_IDENTIFIER_BYTES,
    `primary key constraint "${name}" is ${bytes} bytes; Postgres truncates at ${MAX_IDENTIFIER_BYTES}, so the name the database holds is not this one`,
    `psql "$DATABASE_URL" -c "select conname from pg_constraint where contype = 'p' and conrelid = '${table}'::regclass"   # then write the drop constraint / add primary key pair by hand in a new migration`,
  );
  return name;
}

export function addPrimaryKey(table: string, columns: readonly string[]): string {
  const key = columns.map((column) => identifier(column).text).join(', ');
  return (
    `alter table ${identifier(table).text} add constraint ` +
    `${identifier(primaryKeyName(table)).text} primary key (${key});`
  );
}

/**
 * `if exists` for the generator, and for a reason the server supplies: dropping a COLUMN drops
 * every constraint written over it, so a key whose column this same migration removes — in either
 * direction — may already be gone by the time this statement runs.
 */
export function dropPrimaryKey(table: string, constraint: string, ifExists: boolean): string {
  return (
    `alter table ${identifier(table).text} drop constraint ` +
    `${ifExists ? 'if exists ' : ''}${identifier(constraint).text};`
  );
}

/** Two column lists, equal in ORDER — the one copy; `drift.ts` compares the live key through it. */
export const sameColumns = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((column, index) => column === b[index]);

/** ORDER is part of a key: `(org_id, id)` and `(id, org_id)` are two different indexes. */
export function keyChanged(entity: EntityDescriptionLike, live: TableDescription): boolean {
  return !sameColumns(entity.primaryKey, live.primaryKey);
}

/**
 * The recorded foreign keys written against the key being replaced. Postgres refuses to drop a
 * constraint another one depends on (`2BP01`), and re-pointing someone else's key is not a diff
 * this generator can derive: the referencing table's own columns would have to change with it.
 */
function inboundKeys(current: SchemaDescription, live: TableDescription): readonly string[] {
  const key = new Set(live.primaryKey);
  return current.tables.flatMap((table) =>
    table.foreignKeys
      .filter(
        (foreign) =>
          foreign.referencedTable === live.name &&
          foreign.referencedColumns.length === key.size &&
          foreign.referencedColumns.every((column) => key.has(column)),
      )
      .map((foreign) => foreign.name),
  );
}

/**
 * The first half, ahead of every column statement of the table: the old key goes. `down` is
 * reversed at assembly, so the statement pushed here runs LAST on the way back — the old key is
 * restored only once every column it names is back.
 */
export function dropChangedKey(
  entity: EntityDescriptionLike,
  live: TableDescription,
  current: SchemaDescription,
  plan: Plan,
  migration: string,
): void {
  if (!keyChanged(entity, live) || live.primaryKey.length === 0) return;
  const inbound = inboundKeys(current, live);
  if (inbound.length > 0) {
    throw migrationIrreversible(
      `changing the primary key of "${entity.table}" drops the constraint ${inbound.map((name) => `"${name}"`).join(', ')} ${inbound.length === 1 ? 'is' : 'are'} written against, and re-pointing another table's foreign key is not a change this generator can derive`,
      `x db gen "${migration}"   # after removing the references() to "${entity.table}" behind ${inbound.join(', ')} — drop the keys in one migration, change the primary key in the next, restore them in a third`,
    );
  }
  plan.up.push(dropPrimaryKey(entity.table, primaryKeyName(entity.table), true));
  plan.down.push(addPrimaryKey(entity.table, live.primaryKey));
}

/**
 * The second half, after the table's last column statement — the `drop column`s included: every
 * column the new key names exists by now, and none it no longer names is still in the way.
 */
export function addChangedKey(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
): void {
  if (!keyChanged(entity, live) || entity.primaryKey.length === 0) return;
  plan.up.push(addPrimaryKey(entity.table, entity.primaryKey));
  plan.down.push(dropPrimaryKey(entity.table, primaryKeyName(entity.table), true));
}
