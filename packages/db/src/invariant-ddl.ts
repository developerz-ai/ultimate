// Single responsibility: the DDL an entity's INVARIANTS become — what a rule is called, the index a
// `unique` becomes, and the CHECK list a caller merges. `check-ddl.ts` owns the plan those checks
// join, because a column declares one of its own and the two are one list on the server.
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
import type { CheckDescription } from './introspect';
import { constraintNameUnsafe } from './invariant-errors';
import { identifier } from './sql';

/**
 * `NAMEDATALEN - 1`. Postgres truncates a longer identifier and says nothing, so two constraints
 * sharing their first 63 bytes are ONE constraint on the server while both names still differ in
 * the snapshot — invisible to a drift check comparing declared names. `@ultimat3/entity` bounds
 * the index names it mints for the same reason; this bound is Postgres', not a convention, so
 * stating it on both sides of the tier seam is one fact written twice rather than two rules.
 *
 * Exported so `check-ddl.ts` bounds a column's constraint name against the same number: two copies
 * of NAMEDATALEN in one package is two rules that can drift, which is the thing it exists against.
 */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * The convention alone, with nothing validated and nothing refused. One copy, so `constraintNameFor`
 * and `namesConstraint` can never disagree about what a rule's constraint is called — the two
 * questions "what do I emit" and "is this recorded constraint that rule's" are the same string.
 */
function spellConstraintName(table: string, invariant: InvariantDescriptionLike): string {
  return `${table}_${invariant.name}_${invariant.kind === 'unique' ? 'key' : 'check'}`;
}

/**
 * Whether a CHECK a migration RECORDED is this rule's own enforcement in the database. Two
 * spellings, because two writers name it: this generator's `<table>_<name>_check`, and a
 * hand-written migration that used the rule's own name — which is what `examples/dummy`'s
 * `0001_init.sql` did for every one of its app-judged rules.
 *
 * Never throws, unlike `constraintNameFor`: its caller is a REPORTER (`unrendered.ts`), reached by
 * `x verify`'s drift step, where a throw replaces a finding with a crash. The RECORDED name is
 * required to be an identifier and the invariant's is not, because only the recorded one is written
 * back out — into a `--` comment and into a `fix:` — and a sidecar is a hand-editable file.
 */
export function namesConstraint(
  table: string,
  invariant: InvariantDescriptionLike,
  recorded: string,
): boolean {
  if (!isIdentifier(recorded)) return false;
  return recorded === invariant.name || recorded === spellConstraintName(table, invariant);
}

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
  const name = spellConstraintName(table, invariant);
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

/** Whether `identifier()` would accept this name — the package's one rule, asked rather than run. */
export function isIdentifier(value: string): boolean {
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

/**
 * The CHECK constraints this entity's INVARIANTS declare, in declaration order. The predicate is
 * handed on unvalidated: `check-ddl.ts` refuses a second command over the MERGED list, so one rule
 * covers a rule's expression and a column's alike rather than one guard per producer.
 */
export function invariantChecks(entity: EntityDescriptionLike): readonly CheckDescription[] {
  return (entity.invariants ?? [])
    .filter((invariant) => invariant.kind === 'check' && invariant.sql !== null)
    .map((invariant) => ({
      name: constraintNameFor(entity.table, invariant),
      expression: invariant.sql ?? '',
    }));
}
