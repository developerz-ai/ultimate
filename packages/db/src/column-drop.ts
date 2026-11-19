// Single responsibility: a column leaving a table — the two consents its loss is asked for, the
// `drop column`, and what `down` puts back. Split from `generate.ts` at its size ceiling, and
// because `regenerate`'s plain -> generated rebuild is the same drop and must meet the same gate.

import { renderFixShellArg } from '@ultimat3/core';
import type { EntityDescriptionLike } from './entity-shape';
import { addForeignKey, keyId, unrestorableNote } from './foreign-key';
import type { ConstraintPlans, Plan } from './foreign-key-plan';
import { becomesGenerated } from './generated-column';
import { asDeclared, createIndex } from './index-ddl';
import type { ColumnDescription, TableDescription } from './introspect';
import { migrationIrreversible } from './migration-errors';
import { migrationNameArg } from './primary-key';
import { contractsMarkerFor } from './retired';
import { indexDependsOn } from './retype-dependents';
import { columnDropNotRetired, columnRebuildNotRetired } from './rolling-errors';
import { identifier } from './sql';

/** The three `GenerateOptions` fields a drop reads: the migration's name and the two flags. */
export interface DropConsent {
  readonly name: string;
  readonly allowDestructive?: boolean | undefined;
  readonly rollingUnsafe?: boolean | undefined;
}

/**
 * Order matters: the release boundary first, with the flag or without it. Retiring is what earns
 * the next question; it is never consent to losing the rows, so that one still stands. Answers
 * whether the column goes without having been retired, which is what `-- rolling-unsafe: true`
 * records on the file.
 */
function admitted(
  entity: EntityDescriptionLike,
  column: ColumnDescription,
  consent: DropConsent,
  rebuilt: boolean,
): boolean {
  const unretired = column.retired !== true;
  const name = migrationNameArg(consent.name);
  // A column's name is a sidecar's to choose, so it reaches a `fix:` through the shell screen.
  const shown = renderFixShellArg(column.name, '<column>');
  if (unretired && consent.rollingUnsafe !== true) {
    throw rebuilt
      ? columnRebuildNotRetired(entity.name, entity.table, column.name, consent.name)
      : columnDropNotRetired(entity.name, entity.table, column.name, name);
  }
  if (consent.allowDestructive !== true) {
    throw rebuilt
      ? migrationIrreversible(
          `making "${entity.table}"."${column.name}" a generated column drops it and adds it back computed, which discards every value stored in it and cannot be undone`,
          `x db gen ${name} --allow-destructive   # or keep "${shown}" plain and declare the generated column under a new name`,
        )
      : migrationIrreversible(
          `dropping "${entity.table}"."${column.name}" discards its rows and cannot be undone`,
          `x db gen ${name} --allow-destructive   # or put "${shown}" back in columns and keep it`,
        );
  }
  return unretired;
}

/**
 * A plain column the entity now declares generated is `drop column` + `add column`
 * (`regenerate`): the stored values are gone and a pod of the previous release still writes the
 * column, which Postgres refuses on a generated one (`428C9`). So it is asked exactly what an
 * ordinary drop is asked, BEFORE the table's diff writes a statement — until 2026-11-19 it was
 * asked nothing, and `x db gen` wrote `-- destructive: true` over a loss nobody had consented to.
 * Answers whether any of them went unretired.
 */
export function admitRebuilds(
  entity: EntityDescriptionLike,
  live: TableDescription,
  consent: DropConsent,
): boolean {
  const recorded = new Map(live.columns.map((column) => [column.name, column]));
  let unretired = false;
  for (const column of entity.columns) {
    const held = recorded.get(column.column);
    if (held === undefined || !becomesGenerated(column, held)) continue;
    if (admitted(entity, held, consent, true)) unretired = true;
  }
  return unretired;
}

/**
 * What hung off the dropped columns, as the previous snapshot recorded it: `drop column` took every
 * foreign key over one and every index that depends on one (`indexDependsOn`: a key, an INCLUDE
 * column, a predicate or an expression that reads it), and `add column` brings none of them back. Without these a
 * rollback left a database its own snapshot called drifted (`missing-index`,
 * `missing-foreign-key`), and the `down` before it dropped a constraint that was not there
 * (`42704`). A CHECK is `checkPlan`'s, already restored.
 *
 * Pushed BEFORE the `add column`s because `down` is reversed at assembly, keys before indexes for
 * the same reason. A statement another arm already pushed is not pushed twice: a retype or a
 * rebuild of a second column of the same index restores it too (`moveDependentsAside`), and a
 * second `create index` under one name is `42P07`.
 */
function restoreDependents(
  live: TableDescription,
  dropped: ReadonlySet<string>,
  plan: Plan,
  plans: ConstraintPlans,
): void {
  const over = (columns: readonly string[]): boolean => columns.some((each) => dropped.has(each));
  const restores: string[] = [];
  for (const key of live.foreignKeys) {
    if (!over(key.columns) || plans.predropped.has(keyId(live.name, key.name))) continue;
    restores.push(
      plans.doomed.has(key.referencedTable)
        ? unrestorableNote(live.name, key.name, key.referencedTable)
        : addForeignKey(live.name, key),
    );
  }
  for (const index of live.indexes) {
    if (index.primary || ![...dropped].some((column) => indexDependsOn(index, column))) continue;
    restores.push(createIndex(live.name, asDeclared(index)));
  }
  plan.down.push(...restores.filter((statement) => !plan.down.includes(statement)));
}

/**
 * Every recorded column the entity neither declares nor retires: admitted, dropped, and put back
 * empty by `down`. Answers whether any of them was never retired.
 */
export function dropColumns(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  plans: ConstraintPlans,
  consent: DropConsent,
): boolean {
  const kept = new Set([
    ...entity.columns.map((column) => column.column),
    ...(entity.retired ?? []),
  ]);
  const leaving = live.columns.filter((column) => !kept.has(column.name));
  if (leaving.length === 0) return false;
  let unretired = false;
  for (const column of leaving) {
    if (admitted(entity, column, consent, false)) unretired = true;
  }
  restoreDependents(live, new Set(leaving.map((column) => column.name)), plan, plans);
  for (const column of leaving) {
    if (column.retired === true) plan.up.push(contractsMarkerFor(entity.table, column.name));
    plan.up.push(
      `alter table ${identifier(entity.table).text} drop column ${identifier(column.name).text};`,
    );
    plan.down.push(
      `alter table ${identifier(entity.table).text} add column ` +
        `${identifier(column.name).text} ${column.dataType};` +
        ' -- data is not restored',
    );
  }
  return unretired;
}
