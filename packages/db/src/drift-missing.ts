// Single responsibility: the findings for something a migration declares that the catalog lacks
// or holds rebuilt — a table, a column, an index, a foreign key — each with the statement that puts
// it back, built from the snapshot. Split from `drift-findings.ts`, whose helpers these share.

import {
  byHand,
  type DriftDifference,
  NULLS_FIRST,
  pathTo,
  RE_CHECK,
  repair,
  spellable,
} from './drift-findings';
import { addForeignKey } from './foreign-key';
import { asDeclared, createIndex, mayBeConstraintBacked } from './index-ddl';
import type { ColumnDescription, ForeignKeyDescription, IndexDescription } from './introspect';
import { identifier } from './sql';

/**
 * Why none of these says `x db migrate`: `checkDrift` compares the catalog with the migrations the
 * LEDGER holds, so the migration that declares the missing thing has already run and re-running the
 * migrator applies nothing — the same finding comes back. The fix is the statement, against this
 * database (`repair`), the rule `missingCheck` and `changedPrimaryKey` already follow.
 */

/**
 * A snapshot column as a column definition. `dataType`, `default` and `generated` are the DECLARED
 * side's own text, out of the author's migration — the trust `missingCheck` gives its predicate —
 * and `psqlCommand` closes the shell layer around all of it. `notNull` is the caller's: an `add
 * column … not null` with no value to fill existing rows with is refused on a table holding any.
 */
const columnClause = (column: ColumnDescription, notNull: boolean): string => {
  const value =
    column.generated !== undefined
      ? ` generated always as (${column.generated}) stored`
      : column.default === null
        ? ''
        : ` default ${column.default}`;
  return `${identifier(column.name).text} ${column.dataType}${value}${notNull ? ' not null' : ''}`;
};

/** Every row an `add column` lands on gets a value, so `not null` can ride on the same statement. */
const filled = (column: ColumnDescription): boolean =>
  column.default !== null || column.generated !== undefined;

const LATER_NOT_NULL = `then x db migrate, which re-checks and names the set not null — ${NULLS_FIRST}`;

/** The statement, or `byHand` when a name in it is refused or a writer refuses the declaration. */
const statementOr = (
  schema: string,
  names: readonly string[],
  steps: string,
  write: () => string,
  note = RE_CHECK,
): string => {
  const path = pathTo(schema);
  if (path === null || !spellable(names)) return byHand(steps);
  try {
    return repair(path, write(), note);
  } catch {
    return byHand(steps, 'migrations declare it in a form no statement here can write');
  }
};

/**
 * Added NULLABLE when nothing fills the rows already there — the strict form fails on a populated
 * table — and the re-check then reports `changed-column`, whose fix is the `set not null`.
 */
export function missingColumn(
  schema: string,
  table: string,
  column: ColumnDescription,
): DriftDifference {
  const strict = !column.nullable && filled(column);
  return {
    kind: 'missing-column',
    table,
    column: column.name,
    cause: `table "${table}" is missing column "${column.name}" that migrations declare`,
    fix: statementOr(
      schema,
      [table, column.name],
      'add the column this difference names back, as the migration that declares it does',
      () => `alter table ${identifier(table).text} add column ${columnClause(column, strict)};`,
      strict || column.nullable ? RE_CHECK : LATER_NOT_NULL,
    ),
  };
}

/**
 * The table and its primary key only. An index, a foreign key, a check or a trigger has a finding
 * of its own with its own repair, which the re-check reports next — one statement per fact, so a
 * key to a table that is also missing is never part of the statement that would fail on it.
 */
export function missingTable(
  schema: string,
  table: string,
  columns: readonly ColumnDescription[],
  primaryKey: readonly string[],
): DriftDifference {
  const create = (): string => {
    const clauses = [...columns]
      .sort((a, b) => a.position - b.position)
      .map((column) => columnClause(column, !column.nullable));
    if (primaryKey.length > 0) {
      clauses.push(`primary key (${primaryKey.map((name) => identifier(name).text).join(', ')})`);
    }
    return `create table ${identifier(table).text} (${clauses.join(', ')});`;
  };
  return {
    kind: 'missing-table',
    table,
    column: null,
    cause: `table "${table}" is declared by migrations but does not exist`,
    fix: statementOr(
      schema,
      [table, ...columns.map((column) => column.name), ...primaryKey],
      'create the table this difference names, as the migration that declares it does',
      create,
      `${RE_CHECK} and names its indexes, keys, checks and triggers next`,
    ),
  };
}

const indexNames = (table: string, index: IndexDescription): readonly string[] => [
  table,
  index.name,
  ...index.columns,
];

export function missingIndex(
  schema: string,
  table: string,
  index: IndexDescription,
): DriftDifference {
  return {
    kind: 'missing-index',
    table,
    column: null,
    cause: `table "${table}" is missing index "${index.name}" that migrations declare`,
    fix: statementOr(
      schema,
      indexNames(table, index),
      'create the index this difference names, as the migration that declares it does',
      () => createIndex(table, asDeclared(index)),
    ),
  };
}

/**
 * Postgres has no `alter index` for any part drift compares, so the repair is a drop and the
 * declared build, in one transaction. A live index a UNIQUE constraint may own refuses `drop index`
 * (2BP01), so its constraint goes first — `if exists`, because it may be a plain index after all.
 */
export function changedIndex(
  schema: string,
  table: string,
  declared: IndexDescription,
  held: IndexDescription,
  detail: string,
): DriftDifference {
  const rebuild = (): string => {
    const name = identifier(declared.name).text;
    const owner = mayBeConstraintBacked(held)
      ? `alter table ${identifier(table).text} drop constraint if exists ${name}; `
      : '';
    return `${owner}drop index if exists ${name}; ${createIndex(table, asDeclared(declared))}`;
  };
  return {
    kind: 'changed-index',
    table,
    column: null,
    cause: `index "${declared.name}" on "${table}" ${detail}, not what migrations declare`,
    fix: statementOr(
      schema,
      indexNames(table, declared),
      'drop the index this difference names and create it as the migration that declares it does',
      rebuild,
    ),
  };
}

export function missingForeignKey(
  schema: string,
  table: string,
  key: ForeignKeyDescription,
): DriftDifference {
  return {
    kind: 'missing-foreign-key',
    table,
    column: null,
    cause:
      `table "${table}" has no foreign key on (${key.columns.join(', ')}) to ` +
      `"${key.referencedTable}" (${key.referencedColumns.join(', ')}) that migrations declare`,
    fix: statementOr(
      schema,
      [table, key.name, key.referencedTable, ...key.columns, ...key.referencedColumns],
      'add the foreign key this difference names back, as the migration that declares it does',
      () => addForeignKey(table, key),
      'a row it finds is X_DB_FOREIGN_KEY_VIOLATION: repair that row, run it again, then x db migrate, which re-checks',
    ),
  };
}
