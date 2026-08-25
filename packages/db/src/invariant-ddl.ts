// Single responsibility: the DDL an entity's invariants become, and which of them a migration must
// add or drop. `generate.ts` assembles the plan; this file decides what a rule IS in SQL. Split out
// for the reason `generated-column.ts` and `foreign-key.ts` are: a check and a unique are two
// different statements with two different diffs, and neither is the ordinary column's.
//
// A `check` becomes a named CONSTRAINT, inline on a created table and `alter table … add
// constraint` on an existing one. A `unique` becomes a unique INDEX — never a UNIQUE constraint —
// because a soft-deleting entity stamps `deleted_at is null` onto it and Postgres has no partial
// unique constraint, only a partial unique index. An `assert` becomes nothing: it is declared as a
// rule only the app can judge (`sql: null`), which is what `hasJsOnlyInvariant` reads it as.

import { assert } from '@ultimat3/core';
import type {
  EntityDescriptionLike,
  IndexDescriptionLike,
  InvariantDescriptionLike,
} from './entity-shape';
import { indexMethodOf } from './index-method';
import type { CheckDescription, TableDescription } from './introspect';
import { constraintExpressionUnsafe, constraintNameUnsafe } from './invariant-errors';
import { identifier } from './sql';
import { statementsOf } from './statement-split';

/**
 * `NAMEDATALEN - 1`. Postgres truncates a longer identifier and says nothing, so two constraints
 * sharing their first 63 bytes are ONE constraint on the server while both names still differ in
 * the snapshot — invisible to a drift check comparing declared names. `@ultimat3/entity` bounds
 * the index names it mints for the same reason; this bound is Postgres', not a convention, so
 * stating it on both sides of the tier seam is one fact written twice rather than two rules.
 */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * The constraint an invariant becomes: `<table>_<name>_check` / `<table>_<name>_key`.
 *
 * The same string `@ultimat3/entity`'s `constraintName` builds, and it has to be re-derived here
 * rather than read off the description because the projection carries the rule's own name and not
 * the constraint's. Both spellings are pinned — entity's by `invariants.test.ts`, this one by
 * `generate-invariant.test.ts` — and a divergence would show up as a constraint this generator
 * adds twice under two names.
 */
export function constraintNameFor(table: string, invariant: InvariantDescriptionLike): string {
  const suffix = invariant.kind === 'unique' ? 'key' : 'check';
  const name = `${table}_${invariant.name}_${suffix}`;
  // Through the package's one identifier rule, never a second regex: an invariant name is
  // validated by nobody at declaration, so this is where a name that closes the quote is stopped.
  if (!isIdentifier(invariant.name) || !isIdentifier(table)) {
    throw constraintNameUnsafe(table, invariant.name);
  }
  // Bytes and not characters: 63 is what the server counts, and `.length` stops seeing the
  // truncation the moment a name is not ASCII.
  const bytes = new TextEncoder().encode(name).length;
  assert(
    bytes <= MAX_IDENTIFIER_BYTES,
    `constraint name "${name}" is ${bytes} bytes; Postgres truncates at ${MAX_IDENTIFIER_BYTES} and says nothing`,
    `invariant('${invariant.name.slice(0, 20)}…', …)   # shorten the invariant name, then x db gen`,
  );
  return name;
}

function isIdentifier(value: string): boolean {
  try {
    identifier(value);
    return true;
  } catch {
    // `identifier` throws `X_SQL_UNSAFE` for exactly one reason and the caller re-throws its own,
    // naming the invariant rather than the raw name — so nothing is swallowed here.
    return false;
  }
}

/**
 * The predicate, refused when it holds a second command. `statementsOf` is this package's one
 * lexer, so a `;` inside a string literal — `check (tag <> ';')` — is data and not a split.
 */
function predicate(constraint: string, sql: string): string {
  const commands = statementsOf(sql).length;
  if (commands > 1) throw constraintExpressionUnsafe(constraint, commands);
  return sql;
}

/**
 * The physical columns a `unique` invariant names. `columns` when the description carries it;
 * otherwise the `sql` field, which for a `unique` IS the comma-joined column list.
 *
 * The fallback is a re-read, not a name parsed back out of a convention: every part is validated
 * as an identifier and a part that is not one is REFUSED, so the failure mode `parseIndexName` had
 * — `posts_org_id_created_at_idx` silently becoming the column `"org_id_created_at"` — cannot
 * happen, because a physical column name cannot contain a comma. It exists so this package can
 * emit the constraint before `@ultimat3/entity` (tier 2, which this one may not import) projects
 * `Invariant.columns`; the field it already holds is what makes the fallback deletable later.
 */
export function uniqueColumns(
  table: string,
  invariant: InvariantDescriptionLike,
): readonly string[] {
  const declared = invariant.columns ?? (invariant.sql ?? '').split(',').map((part) => part.trim());
  assert(
    declared.length > 0 && declared.every((column) => column.length > 0),
    `unique invariant "${invariant.name}" on "${table}" names no columns`,
    `invariant('${invariant.name}', c.unique(['<column>']))   # name the columns, then x db gen`,
  );
  for (const column of declared) {
    if (!isIdentifier(column)) throw constraintNameUnsafe(table, column);
  }
  return declared;
}

/** A `unique` invariant as the index it is — so one list of indexes is created, diffed and recorded. */
function uniqueIndexOf(
  entity: EntityDescriptionLike,
  invariant: InvariantDescriptionLike,
): IndexDescriptionLike {
  return {
    name: constraintNameFor(entity.table, invariant),
    columns: uniqueColumns(entity.table, invariant),
    unique: true,
    where: invariant.where,
    order: null,
  };
}

/** Every part of an index Postgres fixes at creation — the dedup key, and `redefineIndex`'s. */
const shapeOf = (index: IndexDescriptionLike): string =>
  JSON.stringify([
    [...index.columns],
    index.unique,
    index.where,
    index.order,
    indexMethodOf(index),
  ]);

/**
 * The indexes this entity declares: its own, plus one per `unique` invariant. ONE list, because
 * `createTable`, `diffTable` and `snapshotOf` must agree about what exists — a unique index emitted
 * but not recorded is `42P07` on the next `x db gen`, which is a worse failure than the silent drop
 * this whole change is against.
 *
 * Deduped on the whole definition and never on the name, the rule `@ultimat3/entity` already
 * applies. The case that bites: `invariant('slug', c.unique(['slug']))` on `members` derives
 * `members_slug_key`, byte for byte what Postgres calls the index a `unique` column clause creates
 * — so an entity declaring both pushes two `create unique index` statements under one name, which
 * is `42P07` and a migration that cannot be applied at all. The entity's own index wins, because
 * `impliedByColumnClause` is written against that name.
 */
export function declaredIndexes(entity: EntityDescriptionLike): readonly IndexDescriptionLike[] {
  const invariants = entity.invariants ?? [];
  if (invariants.length === 0) return entity.indexes;
  const seen = new Set(entity.indexes.map(shapeOf));
  const extra: IndexDescriptionLike[] = [];
  for (const invariant of invariants) {
    if (invariant.kind !== 'unique') continue;
    const index = uniqueIndexOf(entity, invariant);
    if (seen.has(shapeOf(index))) continue;
    seen.add(shapeOf(index));
    extra.push(index);
  }
  return [...entity.indexes, ...extra];
}

/** The CHECK constraints this entity declares, in declaration order. */
export function declaredChecks(entity: EntityDescriptionLike): readonly CheckDescription[] {
  return (entity.invariants ?? [])
    .filter((invariant) => invariant.kind === 'check' && invariant.sql !== null)
    .map((invariant) => {
      const name = constraintNameFor(entity.table, invariant);
      return { name, expression: predicate(name, invariant.sql ?? '') };
    });
}

/** `constraint "n" check (…)` — the clause form, for a table this migration creates. */
export function checkClauses(entity: EntityDescriptionLike): readonly string[] {
  return declaredChecks(entity).map(
    (check) => `constraint ${identifier(check.name).text} check (${check.expression})`,
  );
}

const addCheck = (table: string, check: CheckDescription): string =>
  `alter table ${identifier(table).text} add constraint ${identifier(check.name).text} ` +
  `check (${check.expression});`;

const dropCheck = (table: string, name: string): string =>
  `alter table ${identifier(table).text} drop constraint ${identifier(name).text};`;

/**
 * Which CHECK constraints an existing table gains, loses or has rebuilt. Postgres has no `alter
 * constraint` for a predicate, so a moved expression is a drop and an add — the same shape
 * `redefineIndex` uses, and `down` is pushed forwards and read backwards for the same reason.
 *
 * Both directions, the rule `foreignKeyPlan` states: a snapshot may not lie. A recorded constraint
 * the entity no longer declares is DROPPED, and its `down` re-adds it from the expression the
 * snapshot holds — so unlike a dropped column there is nothing to restore and nothing to refuse.
 * `destructive.ts` deliberately excludes `drop constraint` for exactly this reason.
 */
export function checkPlan(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: { up: string[]; down: string[] },
): void {
  const recorded = new Map((live.checks ?? []).map((check) => [check.name, check]));
  const wanted = declaredChecks(entity);
  for (const check of wanted) {
    const held = recorded.get(check.name);
    if (held === undefined) {
      plan.up.push(addCheck(entity.table, check));
      plan.down.push(dropCheck(entity.table, check.name));
      continue;
    }
    if (held.expression === check.expression) continue;
    plan.up.push(dropCheck(entity.table, check.name), addCheck(entity.table, check));
    plan.down.push(addCheck(entity.table, held), dropCheck(entity.table, check.name));
  }
  const declared = new Set(wanted.map((check) => check.name));
  for (const check of live.checks ?? []) {
    if (declared.has(check.name)) continue;
    plan.up.push(dropCheck(entity.table, check.name));
    plan.down.push(addCheck(entity.table, check));
  }
}
