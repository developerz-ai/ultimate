// Single responsibility: the attributes of an EXISTING column that move in place — its default, its
// collation and its nullability. Split from `generate.ts` because `diffTable` emitted SQL for a type change only:
// a changed or removed `.default()`, or a nullability change, emitted nothing while the snapshot
// beside it recorded the move, so `x verify` answered `X_DB_SCHEMA_UNMIGRATED` and its own fix,
// `x db gen`, produced an empty diff. A gate red forever, with the repair being the thing that failed.

import { defaultExpression, hasUnrenderedDefault } from './column-default';
import { columnDefaultUnsafe } from './ddl-errors';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import { appendOnlyBackfillRefused } from './generate-append-only';
import type { ColumnDescription } from './introspect';
import { identifier } from './sql';
import { sqlType } from './sql-type';
import { statementsOf } from './statement-split';

/**
 * The recorded default comes out of a `.snapshot.json` anything may edit and is SPLICED into
 * `down`, so it takes the one-expression screen `generatedClause` gives a generated column's.
 * The wanted side is `defaultExpression`'s own rendering (`literal()` for a value), safe by
 * construction, and screened anyway because the check costs one scan and the two sides then
 * cannot drift apart.
 */
function screened(column: string, expression: string): string {
  const commands = statementsOf(expression).length;
  if (commands > 1) throw columnDefaultUnsafe(column, commands);
  return expression;
}

/**
 * ` collate "<name>"` after a type, or nothing. An ALTER … TYPE with no COLLATE resets the column to
 * its type's default collation, so a retype states the collation it keeps — `"default"` included.
 */
export function collateClause(collation: string | null | undefined, always = false): string {
  if (collation == null) return always ? ' collate "default"' : '';
  return ` collate ${identifier(collation).text}`;
}

/** The type a column clause declares: `text`, or `text collate "C"` when one was declared. */
export function typeClause(column: ColumnDescriptionLike): string {
  return `${sqlType(column.kind)}${collateClause(column.collation)}`;
}

/** What the column should hold as a default: one this generator cannot render stays as it is. */
export function wantedDefault(
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
): string | null {
  return hasUnrenderedDefault(column) ? recorded.default : defaultExpression(column);
}

/**
 * The ALTER of a retype, with the column's default out of its way. Postgres converts a default with
 * the column and refuses when no assignment cast exists (`42804`), whatever the new default is, so
 * it is dropped first and set after: a type change is the one move that has to span the default.
 * `down` is reversed at assembly, so what it pushes here runs last to first: drop the new default,
 * retype back, restore the old one. With no default on either side, this is the bare ALTER. Each
 * side states its own collation, which an ALTER … TYPE would otherwise reset to the type's default.
 */
export function retypeOverDefault(
  table: string,
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
  plan: Plan,
): void {
  const alter = `alter table ${identifier(table).text} alter column ${identifier(column.column).text}`;
  const retype = (type: string, collation: string | undefined): string =>
    `${alter} type ${type}${collateClause(collation)} using ${identifier(column.column).text}::${type};`;
  const up = retype(sqlType(column.kind), column.collation);
  const down = retype(recorded.dataType, recorded.collation);
  const drop = `${alter} drop default;`;
  const set = (expression: string): string =>
    `${alter} set default ${screened(column.column, expression)};`;
  const wanted = wantedDefault(column, recorded);
  const held = recorded.default;
  if (held !== null) {
    plan.up.push(drop);
    plan.down.push(set(held));
  }
  plan.up.push(up);
  plan.down.push(down);
  if (wanted !== null) {
    plan.up.push(set(wanted));
    plan.down.push(drop);
  }
}

/**
 * `set default` / `drop default` and `drop not null`, each with its reverse in `down` — the shape
 * `redefineIndex` (`index-ddl.ts`) gives a moved index. Becoming NOT NULL is deliberately NOT a
 * bare `set not null`: rows already holding `NULL` make it fail inside `ROLE=migrate`, so it gets
 * the expand/contract note `diffTable` writes for a NOT NULL column added to a populated table —
 * refused on an append-only table, whose backfill the trigger would refuse.
 *
 * A default this generator cannot render (`hasUnrenderedDefault`) moves nothing: dropping the one
 * the database holds would lose a rule the entity still states, and `unrenderedOf` already reports
 * it at the top of `up`.
 */
export function alterColumnInPlace(
  entity: EntityDescriptionLike,
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
  plan: Plan,
): void {
  const { table } = entity;
  const alter = `alter table ${identifier(table).text} alter column ${identifier(column.column).text}`;
  const wanted = wantedDefault(column, recorded);
  const held = recorded.default;
  if (wanted !== held) {
    const set = (expression: string | null): string =>
      expression === null
        ? `${alter} drop default;`
        : `${alter} set default ${screened(column.column, expression)};`;
    plan.up.push(set(wanted));
    plan.down.push(set(held));
  }
  // Same type, new collation: no `using`, no rewrite — Postgres rebuilds the column's indexes.
  if ((column.collation ?? null) !== (recorded.collation ?? null)) {
    const type = `${alter} type ${sqlType(column.kind)}`;
    plan.up.push(`${type}${collateClause(column.collation, true)};`);
    plan.down.push(`${type}${collateClause(recorded.collation, true)};`);
  }
  const nullable = !column.notNull;
  if (nullable === recorded.nullable) return;
  if (nullable) {
    plan.up.push(`${alter} drop not null;`);
    plan.down.push(`${alter} set not null;`);
    return;
  }
  // That backfill is an UPDATE, and an append-only table's trigger refuses every one. Refused even
  // with a default now declared: `set default` fills no row that already holds NULL.
  if (entity.appendOnly === true) throw appendOnlyBackfillRefused(entity, column, 'made-not-null');
  // `drop not null` in `down` is a no-op on a column that never became NOT NULL, so the reverse is
  // right whether or not the backfill and its `set not null` were ever run.
  plan.up.push(`-- backfill ${identifier(column.column).text}, then: ${alter} set not null;`);
  plan.down.push(`${alter} drop not null;`);
}
