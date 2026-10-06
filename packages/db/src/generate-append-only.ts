// Single responsibility: the trigger an `entity({ appendOnly: true })` table carries, emitted once.
// The repository refuses update and delete above the driver; this is the same guarantee held by the
// DATABASE, so raw SQL, a second app on the same schema and a hand-written driver are refused too.
// Recorded on the snapshot (`appendOnly: true`), which is what stops it being re-emitted.

import { renderFixLiteral } from '@ultimat3/core';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { DbError } from './errors';
import type { Plan } from './foreign-key-plan';
import { findTable, type SchemaDescription } from './introspect';
import { identifier } from './sql';

/**
 * The trigger's name — the SAME on every table, because a trigger name is unique per table, never
 * per schema. A per-table name (`<table>_append_only`) would pass 63 bytes on a long table name,
 * Postgres would truncate it in silence, and drift would compare the untruncated name forever.
 */
export const APPEND_ONLY_TRIGGER = 'ultimate_append_only';

/**
 * One function for every append-only table: `tg_table_name` says which table refused. Not `x_`
 * prefixed — that namespace is framework bookkeeping created at boot (`FRAMEWORK_TABLE_PREFIX`), and
 * this function is created by the app's own migrations, so the schema dump files it with them.
 */
export const APPEND_ONLY_FUNCTION = 'ultimate_refuse_append_only';

/**
 * `create or replace`, so every migration that adds a trigger may define it again: no migration has
 * to know whether an earlier one already did, and a database where it was dropped by hand gets it
 * back on the next one. One line, because the drift repair (`drift-append-only.ts`) is the same
 * text as one `psql -c` word.
 *
 * The message LEADS with the code an app searches for, and the SQLSTATE is `23001`
 * (`restrict_violation`): class 23 is "an integrity constraint refused this", which is what an
 * append-only table is — so a caller that already treats class 23 as terminal, never retried,
 * treats this the same. These bytes are in migrations on disk; changing them changes nothing that
 * already shipped.
 */
export const APPEND_ONLY_FUNCTION_SQL =
  `create or replace function ${identifier(APPEND_ONLY_FUNCTION).text}() returns trigger ` +
  'language plpgsql as $append_only$ begin raise exception ' +
  "'X_ENTITY_APPEND_ONLY: % on %.% is refused, the table is append-only', " +
  "tg_op, tg_table_schema, tg_table_name using errcode = '23001', hint = 'insert a new row " +
  "instead; to allow rewrites, remove appendOnly from the entity and run x db gen'; end; " +
  '$append_only$;';

/**
 * `before update or delete … for each row`: a row-level BEFORE trigger raises before the row moves,
 * and it covers `insert … on conflict do update` too — the conflict arm IS an update. `truncate` is
 * deliberately not refused: it is no row-level write, `destructive.ts` already gates it in a
 * migration, and the testing package's reusable database empties every table with it.
 */
export const appendOnlyTriggerSql = (table: string): string =>
  `create trigger ${identifier(APPEND_ONLY_TRIGGER).text} before update or delete on ` +
  `${identifier(table).text} for each row execute function ` +
  `${identifier(APPEND_ONLY_FUNCTION).text}();`;

/** `if exists`: a revert must not fail on a database where the trigger was already dropped by hand. */
export const dropAppendOnlyTriggerSql = (table: string): string =>
  `drop trigger if exists ${identifier(APPEND_ONLY_TRIGGER).text} on ${identifier(table).text};`;

/**
 * Installing it on a table that may already hold one: drop-if-exists, then create. A DISABLED
 * trigger of this name is drift (`drift-append-only.ts`) yet still exists, so a bare `create
 * trigger` would fail on it (`42710`) and leave the table unprotected. Idempotent for both a
 * missing and a disabled trigger — the drift repair and an existing table's migration both use it.
 */
export const installAppendOnlyTriggerSql = (table: string): readonly string[] => [
  dropAppendOnlyTriggerSql(table),
  appendOnlyTriggerSql(table),
];

/** Whether the recorded schema says this table carries the trigger. Absent is "not recorded". */
const recorded = (current: SchemaDescription, table: string): boolean =>
  findTable(current, table)?.appendOnly === true;

/**
 * Both directions. Declared and not recorded: define the function (once per migration) and add the
 * trigger; its `down` drops the trigger, except on a table this migration creates, whose `down` is
 * already `drop table`. Recorded and no longer declared: drop it, and `down` puts it back.
 *
 * A table dropped outright needs nothing — the trigger goes with it, and the snapshot stops naming
 * the table. The function is never dropped: other tables may still call it, and a function left with
 * no trigger refuses nothing.
 */
export function appendOnlyPlan(
  plan: Plan,
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
  created: ReadonlySet<string>,
): void {
  const changed = entities.filter(
    (entity) => (entity.appendOnly === true) !== recorded(current, entity.table),
  );
  const added = changed.filter((entity) => entity.appendOnly === true).map((e) => e.table);
  const removed = changed.filter((entity) => entity.appendOnly !== true).map((e) => e.table);
  if (added.length > 0) plan.up.push(APPEND_ONLY_FUNCTION_SQL);
  for (const table of added) {
    // A table this migration creates holds no trigger yet, and its `down` is `drop table`.
    if (created.has(table)) {
      plan.up.push(appendOnlyTriggerSql(table));
      continue;
    }
    plan.up.push(...installAppendOnlyTriggerSql(table));
    plan.down.push(dropAppendOnlyTriggerSql(table));
  }
  for (const table of removed) {
    plan.up.push(dropAppendOnlyTriggerSql(table));
    // Reversed whole: pushed create-then-drop so `down` runs drop-if-exists, then create.
    plan.down.push(...[...installAppendOnlyTriggerSql(table)].reverse());
  }
  // `down` is reversed whole, so the function pushed LAST here runs FIRST there — before the
  // triggers that call it are re-created.
  if (removed.length > 0) plan.down.push(APPEND_ONLY_FUNCTION_SQL);
}

/** Which arm met the column: a new one, or an existing one turned NOT NULL. */
export type AppendOnlyBackfillArm = 'added' | 'made-not-null';

/**
 * A column an append-only table must hold NOT NULL with no default to fill it. Both arms of the
 * diff would emit `-- backfill …, then: set not null` — `diffTable` for a new column,
 * `alterColumnInPlace` for an existing one — and on this table that backfill is an UPDATE the
 * trigger refuses: an instruction nobody can carry out, leaving the column nullable forever.
 * Refused at generation instead; a default is the one way every row gets a value with no UPDATE.
 */
export const appendOnlyBackfillRefused = (
  entity: EntityDescriptionLike,
  column: ColumnDescriptionLike,
  arm: AppendOnlyBackfillArm,
): DbError =>
  new DbError({
    code: 'X_MIGRATION_APPEND_ONLY_BACKFILL',
    cause:
      `${identifier(entity.table).text} is append-only and ` +
      `${arm === 'added' ? 'gains NOT NULL column' : 'turns NOT NULL its column'} ` +
      `${identifier(column.column).text} with no default: existing rows could only be given a ` +
      'value by an UPDATE, which the append-only trigger refuses, so x db gen cannot write a ' +
      'migration that ends with the column NOT NULL',
    // A default fills a column as it is ADDED; it fills no NULL an existing column already holds.
    fix:
      arm === 'added'
        ? `entity(${renderFixLiteral(entity.name, "'<name>'")}, { columns: { ${renderFixLiteral(column.property, "'<col>'")}: <builder>.default(<value>) } })   # then re-run x db gen`
        : `entity(${renderFixLiteral(entity.name, "'<name>'")}, { columns: { ${renderFixLiteral(column.property, "'<col>'")}: <builder>.nullable() } })   # keep it nullable, or add a NEW column with .default(<value>); then re-run x db gen`,
    meta: { table: entity.table, column: column.column, arm },
  });
