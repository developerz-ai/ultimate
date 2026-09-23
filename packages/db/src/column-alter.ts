// Single responsibility: the attributes of an EXISTING column that move in place — its default and
// its nullability. Split from `generate.ts` because `diffTable` emitted SQL for a type change only:
// a changed or removed `.default()`, or a nullability change, emitted nothing while the snapshot
// beside it recorded the move, so `x verify` answered `X_DB_SCHEMA_UNMIGRATED` and its own fix,
// `x db gen`, produced an empty diff. A gate red forever, with the repair being the thing that failed.

import { defaultExpression, hasUnrenderedDefault } from './column-default';
import { columnDefaultUnsafe } from './ddl-errors';
import type { ColumnDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import type { ColumnDescription } from './introspect';
import { identifier } from './sql';
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
 * `set default` / `drop default` and `drop not null`, each with its reverse in `down` — the shape
 * `redefineIndex` (`index-ddl.ts`) gives a moved index. Becoming NOT NULL is deliberately NOT a
 * bare `set not null`: rows already holding `NULL` make it fail inside `ROLE=migrate`, so it gets
 * the expand/contract note `diffTable` writes for a NOT NULL column added to a populated table.
 *
 * A default this generator cannot render (`hasUnrenderedDefault`) moves nothing: dropping the one
 * the database holds would lose a rule the entity still states, and `unrenderedOf` already reports
 * it at the top of `up`.
 */
export function alterColumnInPlace(
  table: string,
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
  plan: Plan,
): void {
  const alter = `alter table ${identifier(table).text} alter column ${identifier(column.column).text}`;
  const wanted = hasUnrenderedDefault(column) ? recorded.default : defaultExpression(column);
  const held = recorded.default;
  if (wanted !== held) {
    const set = (expression: string | null): string =>
      expression === null
        ? `${alter} drop default;`
        : `${alter} set default ${screened(column.column, expression)};`;
    plan.up.push(set(wanted));
    plan.down.push(set(held));
  }
  const nullable = !column.notNull;
  if (nullable === recorded.nullable) return;
  if (nullable) {
    plan.up.push(`${alter} drop not null;`);
    plan.down.push(`${alter} set not null;`);
    return;
  }
  // `drop not null` in `down` is a no-op on a column that never became NOT NULL, so the reverse is
  // right whether or not the backfill and its `set not null` were ever run.
  plan.up.push(`-- backfill ${identifier(column.column).text}, then: ${alter} set not null;`);
  plan.down.push(`${alter} drop not null;`);
}
