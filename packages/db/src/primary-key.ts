// Single responsibility: a table's PRIMARY KEY as DDL — the two statements that move one, the
// generator's arm that decides when they are due, and the refusal for a key another table still
// points at. `diffTable` had no arm for it, so a changed `primaryKey` wrote no statement while the
// snapshot beside it recorded the new key, and drift had no comparison to notice with.

import { assert } from '@ultimat3/core';
import { defaultExpression } from './column-default';
import type { EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import { isGenerated } from './generated-column';
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

/**
 * Postgres marks every key column NOT NULL and dropping the key does not undo it (measured on 17),
 * so a column the declaration allows NULL in needs the constraint taken off by name.
 */
const dropNotNull = (table: string, column: string): string =>
  `alter table ${identifier(table).text} alter column ${identifier(column).text} drop not null;`;

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
  const declared = new Map(entity.columns.map((column) => [column.column, column]));
  const kept = new Set(entity.primaryKey);
  for (const name of live.primaryKey) {
    // Leaving the key, still on the table, and declared nullable: the key's NOT NULL goes with it.
    if (!kept.has(name) && declared.get(name)?.notNull === false) {
      plan.up.push(dropNotNull(entity.table, name));
    }
  }
  // A key column this migration DROPS comes back empty on the way down (`-- data is not
  // restored`), and a primary key over NULLs cannot be added to a table holding a row. The
  // statement is named as the follow-up rather than emitted as one that cannot apply — the form
  // `diffTable` already uses for a NOT NULL add.
  const restored = live.primaryKey.filter((name) => !declared.has(name));
  const restore = addPrimaryKey(entity.table, live.primaryKey);
  plan.down.push(
    restored.length === 0
      ? restore
      : `-- backfill ${restored.map((name) => identifier(name).text).join(', ')}, then: ${restore}`,
  );
}

/**
 * The second half, after the table's last column statement — the `drop column`s included: every
 * column the new key names exists by now, and none it no longer names is still in the way.
 *
 * Refused when the key names a column this same migration ADDS with nothing to fill it: `add
 * column` lands NULL in every existing row and a primary key refuses a NULL, so the generated `up`
 * could not apply to any table holding a row. A default or a generation expression fills it.
 */
export function addChangedKey(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  migration: string,
): void {
  if (!keyChanged(entity, live) || entity.primaryKey.length === 0) return;
  const recorded = new Map(live.columns.map((column) => [column.name, column]));
  const empty = entity.columns.filter(
    (column) =>
      entity.primaryKey.includes(column.column) &&
      !recorded.has(column.column) &&
      !isGenerated(column) &&
      defaultExpression(column) === null,
  );
  if (empty.length > 0) {
    const names = empty.map((column) => `"${column.column}"`).join(', ');
    throw migrationIrreversible(
      `the new primary key of "${entity.table}" names ${names}, which this same migration adds with no default: every existing row would hold NULL there, and a primary key cannot be added over a NULL`,
      `x db gen "${migration}"   # with ${names} declared but left OUT of primaryKey — apply it, backfill the column, then put it in the key and run x db gen again`,
    );
  }
  plan.up.push(addPrimaryKey(entity.table, entity.primaryKey));
  const old = new Set(live.primaryKey);
  for (const name of entity.primaryKey) {
    // Pushed BEFORE the drop so it runs AFTER it on the way down: a column that was nullable
    // before this migration keyed it is nullable again once the key is gone.
    if (!old.has(name) && recorded.get(name)?.nullable === true) {
      plan.down.push(dropNotNull(entity.table, name));
    }
  }
  plan.down.push(dropPrimaryKey(entity.table, primaryKeyName(entity.table), true));
}
