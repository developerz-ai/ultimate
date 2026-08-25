// Single responsibility: every CHECK constraint a table declares — a COLUMN's own and an
// INVARIANT's — and which of them a migration adds, rebuilds or drops. Split out of `generate.ts`
// and `invariant-ddl.ts` because a column check was the one part of a column that reached
// `create table` and nothing else: `columnClause` wrote `check (…)` inline and ANONYMOUS,
// `snapshotOf` recorded nothing for it and `diffTable` had no arm for it, so the SECOND `x db gen`
// turned `enumerated(POST_STATUSES)` into bare `text` accepting any string, and the value set the
// entity still declares left the database with no statement anywhere saying so.
//
// One list, for the reason `declaredIndexes` is one list: `createTable`, `diffTable` and
// `snapshotOf` must agree about what exists, and two producers of `add constraint` that never met
// is `42710` on the very next generation — a migration nobody can apply.

import { assert } from '@ultimat3/core';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import type { CheckDescription, TableDescription } from './introspect';
import { invariantChecks, isIdentifier, MAX_IDENTIFIER_BYTES } from './invariant-ddl';
import { constraintExpressionUnsafe, constraintNameUnsafe } from './invariant-errors';
import { identifier } from './sql';
import { statementsOf } from './statement-split';

/**
 * The convention alone, with nothing validated and nothing refused — one copy, so `columnCheckName`
 * and `columnNamesConstraint` can never disagree about what a column's CHECK is called. The shape
 * `spellConstraintName` already has in `invariant-ddl.ts`, and for the same reason.
 *
 * **Not a convention chosen here.** It is the name Postgres itself mints for an anonymous
 * single-column CHECK — measured against a real server in `check-ddl.live.test.ts`, including for a
 * multi-clause predicate like `scaleCheck`'s, which still names only one column. That is the whole
 * reason this spelling and no other: every database generated before this landed is holding the old
 * inline anonymous form under exactly this name, so a repair migration lands ON the constraint it
 * means to correct instead of beside it under a second name.
 */
const spellColumnCheckName = (table: string, column: string): string => `${table}_${column}_check`;

/**
 * Whether a RECORDED constraint is one of THIS entity's columns' own CHECKs. Validates nothing and
 * never throws, exactly as `namesConstraint` does not, because its caller is a REPORTER
 * (`unrendered.ts`) reached by the `drift` gate step where a throw replaces a finding with a crash.
 *
 * It exists because the two conventions can land on one string: an entity whose `slug` column is
 * checked and that also declares `invariant('slug', …)` as an ASSERT derives `posts_slug_check`
 * twice, and `namesConstraint` matches on the name alone — which it must, since a hand-written
 * migration names the constraint after the rule. Without this the assert reads as "this run drops
 * the CHECK recorded for me" while the run declares and keeps it: a `-- UNRENDERED` block on a
 * migration that lost nothing, which is a marker the next reviewer learns to ignore.
 */
export function columnNamesConstraint(entity: EntityDescriptionLike, recorded: string): boolean {
  return entity.columns.some(
    (column) =>
      column.check !== null && recorded === spellColumnCheckName(entity.table, column.column),
  );
}

/**
 * What a column's own CHECK is called, with both operands validated — the reason `constraintNameFor`
 * validates its own one file over: a physical column name arrives from a projection this package
 * cannot typecheck, `add constraint` takes no parameters, and a name that closes its own quote
 * produced a real `drop table` through `generateMigration` once already.
 */
export function columnCheckName(table: string, column: string): string {
  if (!isIdentifier(table) || !isIdentifier(column)) throw constraintNameUnsafe(table, column);
  const name = spellColumnCheckName(table, column);
  // Bytes, never characters: 63 is what the server counts, and a truncation it performs silently
  // makes two constraints one on the server while both names still differ in the snapshot.
  const bytes = new TextEncoder().encode(name).length;
  assert(
    bytes <= MAX_IDENTIFIER_BYTES,
    `constraint name "${name}" is ${bytes} bytes; Postgres truncates at ${MAX_IDENTIFIER_BYTES} and says nothing`,
    `.column('<shorter>')   # shorten the physical name of "${column}", then x db gen`,
  );
  return name;
}

/**
 * The CHECK constraints an entity's COLUMNS declare, in column order — `enumerated()`'s closed value
 * set, `tz()`'s IANA whitelist, `locale()`'s tag list, money's currency pattern and scale bound.
 *
 * Read off `ColumnDescriptionLike.check`, which is the one field `@ultimat3/entity` projects them
 * through; a column carrying `null` declares none and contributes no row.
 */
export function columnChecks(entity: EntityDescriptionLike): readonly CheckDescription[] {
  return entity.columns
    .filter((column: ColumnDescriptionLike) => column.check !== null)
    .map((column) => ({
      name: columnCheckName(entity.table, column.column),
      expression: column.check ?? '',
    }));
}

/**
 * Every CHECK this table declares. Columns first, then invariants — the order the old generator
 * emitted them in, so a table declaring only invariants produces the statement it always produced.
 *
 * A duplicate name is REFUSED rather than deduped. Two `add constraint` statements under one name
 * is `42710`, and the two sides mean different things: `invariant('status', …)` on a table whose
 * `status` column is an `enumerated()` derives the same `posts_status_check` the column already
 * owns, and silently keeping either one would enforce a rule the entity does not state. Same
 * argument `declaredIndexes` makes for `42P07`, with the opposite remedy, because unlike two
 * identical index definitions these two carry different predicates.
 */
export function declaredChecks(entity: EntityDescriptionLike): readonly CheckDescription[] {
  const checks = [...columnChecks(entity), ...invariantChecks(entity)];
  const seen = new Set<string>();
  for (const check of checks) {
    assert(
      !seen.has(check.name),
      `two declarations on "${entity.table}" name the constraint "${check.name}"`,
      `invariant('${entity.table}_${check.name}', …)   # rename the invariant — a column's own CHECK already holds that name, then x db gen`,
    );
    seen.add(check.name);
    // One command, over the merged list: `statementsOf` is this package's one lexer, so a `;`
    // inside a string literal — `check (tag <> ';')`, and every `oneOf()` value list — is data and
    // not a split. Applied here rather than per producer so a column's predicate, which arrives
    // from an app's own `enumerated([...])` array, is guarded by the same rule an invariant's is.
    const commands = statementsOf(check.expression).length;
    if (commands > 1) throw constraintExpressionUnsafe(check.name, commands);
  }
  return checks;
}

/** `constraint "n" check (…)` — the clause form, for a table this migration creates. */
export function checkClauses(entity: EntityDescriptionLike): readonly string[] {
  return declaredChecks(entity).map(
    (check) => `constraint ${identifier(check.name).text} check (${check.expression})`,
  );
}

/** Exported for `retype-dependents.ts`: a constraint moved out of a retype's way is put back by
 * the same statement that would have added it, never by a second spelling of `add constraint`. */
export const addCheck = (table: string, check: CheckDescription): string =>
  `alter table ${identifier(table).text} add constraint ${identifier(check.name).text} ` +
  `check (${check.expression});`;

export const dropCheck = (table: string, name: string): string =>
  `alter table ${identifier(table).text} drop constraint ${identifier(name).text};`;

/**
 * The one statement that is correct on BOTH databases this generator cannot tell apart.
 *
 * A database generated before column checks were recorded is holding Postgres' own auto-named
 * `<table>_<column>_check` from the old inline anonymous form; a database whose entity gained the
 * check after the table was created is holding nothing, because the old `diffTable` emitted nothing.
 * The snapshot reads identically in both — it records no check either way — so a bare
 * `add constraint` is `42710` on the first, inside `ROLE=migrate`, with the server's words and none
 * of the entity's. `drop constraint if exists` costs a notice on the second and repairs the first.
 */
const rebuildCheck = (table: string, check: CheckDescription): readonly string[] => [
  `alter table ${identifier(table).text} drop constraint if exists ${identifier(check.name).text};`,
  addCheck(table, check),
];

/**
 * Which CHECK constraints an existing table gains, loses or has rebuilt. Postgres has no `alter
 * constraint` for a predicate, so a moved expression is a drop and an add — the same shape
 * `redefineIndex` uses, and `down` is pushed forwards and read backwards for the same reason.
 *
 * Both directions, the rule `foreignKeyPlan` states: a snapshot may not lie. A recorded constraint
 * the entity no longer declares is DROPPED, and its `down` re-adds it from the expression the
 * snapshot holds — so unlike a dropped column there is nothing to restore and nothing to refuse.
 * `destructive.ts` deliberately excludes `drop constraint` for exactly this reason.
 *
 * `rebuilt` names the columns this migration dropped and re-added outright (`regenerate`'s
 * plain -> generated path). The constraint went with the column and the snapshot still records it,
 * so without this the check would be silently gone — the defect class this file exists against,
 * one level in.
 *
 * `predropped` names the CONSTRAINTS this plan already dropped, ahead of a retype whose predicate
 * they were compiled against (`retype-dependents.ts`). Two arms read it and both are about a name
 * that is provably free: a declared one takes the bare `add constraint` rather than the
 * drop-if-exists pair, and a recorded one the entity no longer declares is left alone entirely —
 * `drop constraint` on it a second time is `42704`, and its `down` belongs to the retype that
 * moved it. Keyed by name and not by column because an INVARIANT's check reads a column without
 * being derived from one, which is exactly the constraint `examples/dummy` retypes under.
 */
export function checkPlan(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: { up: string[]; down: string[] },
  rebuilt: ReadonlySet<string> = new Set(),
  predropped: ReadonlySet<string> = new Set(),
): void {
  const recorded = new Map((live.checks ?? []).map((check) => [check.name, check]));
  const present = new Set(live.columns.map((column) => column.name));
  // Checked columns only, in both sets — `columnCheckName` REFUSES a name it cannot spell, and a
  // column declaring no check contributes no constraint for either set to be consulted about. Over
  // every column this would refuse to generate a migration that touches none of them.
  const checked = entity.columns.filter((column) => column.check !== null);
  // Which names the OLD anonymous form could be holding: a column the recorded schema already had,
  // whose check it did not record. A column this migration adds cannot have one, and a rebuilt one
  // lost it with the column, so both take the bare add.
  const exposed = new Set(
    checked
      .filter((column) => present.has(column.column) && !rebuilt.has(column.column))
      .map((column) => columnCheckName(entity.table, column.column)),
  );
  const dropped = new Set(
    checked
      .filter((column) => rebuilt.has(column.column))
      .map((column) => columnCheckName(entity.table, column.column)),
  );
  const wanted = declaredChecks(entity);
  for (const check of wanted) {
    const gone = dropped.has(check.name) || predropped.has(check.name);
    const held = gone ? undefined : recorded.get(check.name);
    if (held === undefined) {
      plan.up.push(
        ...(exposed.has(check.name) && !predropped.has(check.name)
          ? rebuildCheck(entity.table, check)
          : [addCheck(entity.table, check)]),
      );
      plan.down.push(dropCheck(entity.table, check.name));
      continue;
    }
    if (held.expression === check.expression) continue;
    plan.up.push(dropCheck(entity.table, check.name), addCheck(entity.table, check));
    plan.down.push(addCheck(entity.table, held), dropCheck(entity.table, check.name));
  }
  const declared = new Set(wanted.map((check) => check.name));
  for (const check of live.checks ?? []) {
    if (declared.has(check.name) || predropped.has(check.name)) continue;
    plan.up.push(dropCheck(entity.table, check.name));
    plan.down.push(addCheck(entity.table, check));
  }
}
