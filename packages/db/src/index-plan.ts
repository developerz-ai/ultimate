// Single responsibility: which indexes an existing table gains, has rebuilt, or LOSES. Split out
// of `generate.ts` along the seam `check-ddl.ts` and `index-ddl.ts` already drew — `generate.ts`
// assembles a plan, `index-ddl.ts` writes the statements, and this file decides which of them go
// in. `checkPlan` is its shape, deliberately: "what does the record hold that the declaration does
// not" is one question, and a fourth spelling of it is the split axiom 1 refuses.
//
// The removal arm is why this file exists. `diffTable` walked `declaredIndexes(entity)` and matched
// by name, with no reverse pass, so an index the entities stopped declaring stayed on the database
// forever while the sidecar beside it stopped recording it — `examples/dummy` carried
// `member_unique_per_org`, `members_tz_idx` and `post_slug_unique_per_org` through every
// regeneration, and `x verify`'s drift step was green over all three because drift judges the
// declared side. The same defect `foreignKeyPlan` closed on 2026-08-19, one arm over.
//
// KNOWN LIMIT, named rather than half-built: a UNIQUE index that a foreign key on ANOTHER table
// still references cannot be dropped (2BP01), and this arm sees one table at a time. That
// declaration is already broken — the key has nothing to point at — and the failure arrives with
// the server's own words naming both ends.

import type { EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import {
  asDeclared,
  createIndex,
  dropIndex,
  dropRecordedIndex,
  impliedByColumnClause,
  redefineIndex,
} from './index-ddl';
import type { TableDescription } from './introspect';
import { declaredIndexes } from './invariant-ddl';

/**
 * What the rest of this migration has already done to the columns underneath the indexes — every
 * field is a set of names some other arm produced, and each answers "this index is already gone".
 */
export interface IndexPlanContext {
  /** Columns this migration ADDS, whose own `unique` clause brings an index Postgres names. */
  readonly added: ReadonlySet<string>;
  /** Columns `regenerate` dropped and re-added outright — every index over one went with it. */
  readonly rebuilt: ReadonlySet<string>;
  /** Indexes a retype already dropped ahead of its ALTER (`moveDependentsAside`). */
  readonly moved: ReadonlySet<string>;
}

/**
 * Which indexes an existing table gains, has rebuilt, or loses.
 *
 * Declared first and removed last, the order `checkPlan` uses. Both orders are safe — two indexes
 * over the same columns may coexist for the length of one migration — so the tie goes to the file
 * this one is a copy of.
 *
 * `down` is pushed FORWARDS and read backwards, because assembly reverses it: the restore of a
 * removed index therefore lands after the drop of everything created beside it.
 */
export function indexPlan(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  context: IndexPlanContext,
): void {
  const indexed = new Map(live.indexes.map((index) => [index.name, index]));
  const declared = new Set<string>();
  for (const index of declaredIndexes(entity)) {
    declared.add(index.name);
    const recorded = indexed.get(index.name);
    // A rebuilt column took its indexes down with it, and a retype dropped the ones whose
    // predicate it could not survive — either way this one is CREATED rather than compared:
    // `redefineIndex` sees a definition that never moved and would emit nothing at all.
    const gone =
      context.moved.has(index.name) || index.columns.some((each) => context.rebuilt.has(each));
    if (recorded !== undefined && !gone) {
      redefineIndex(entity.table, index, recorded, plan);
      continue;
    }
    // `added` only: an index over a column that was already there is implied by no clause this
    // migration emits, so it still needs a statement of its own.
    if (impliedByColumnClause(entity, index, context.added)) continue;
    plan.up.push(createIndex(entity.table, index));
    // The plain drop, always: this migration CREATED it, with `create index`, so it is an index
    // and never a constraint's — `dropRecordedIndex`'s ambiguity is about the recorded side only.
    plan.down.push(dropIndex(index.name));
  }
  removeUndeclared(entity, live, plan, context, declared);
}

/**
 * Every recorded index this entity no longer declares, dropped — and restored in `down` from what
 * the SNAPSHOT recorded, never from what the entity declares, since the entity is precisely what
 * stopped describing it. The rule the retype path already states.
 *
 * Four names are skipped, and each one is a statement Postgres would refuse or repeat:
 *
 * | skipped                                  | because |
 * |------------------------------------------|---------|
 * | `primary`                                | `drop index` on a primary key's index is 2BP01; the key is `TableDescription.primaryKey`, a different question |
 * | already in `context.moved`               | a retype dropped it ahead of the ALTER — a second drop is 42704 |
 * | over a column in `context.rebuilt`       | it went with the `drop column` half of `regenerate` — 42704 |
 * | over a column this migration DROPS       | `alter table … drop column` takes it, so a drop beside it says nothing new. The rule `foreignKeyPlan` applies to a constraint on a dropped column |
 *
 * A doomed TABLE needs no arm: `generate.ts` only reaches a diff for a table an entity still
 * declares, so `drop table` and this function never meet.
 */
function removeUndeclared(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  context: IndexPlanContext,
  declared: ReadonlySet<string>,
): void {
  const columns = new Set(entity.columns.map((column) => column.column));
  for (const recorded of live.indexes) {
    if (recorded.primary || declared.has(recorded.name)) continue;
    if (context.moved.has(recorded.name)) continue;
    if (recorded.columns.some((column) => context.rebuilt.has(column))) continue;
    if (!recorded.columns.every((column) => columns.has(column))) continue;
    plan.up.push(...dropRecordedIndex(live.name, recorded));
    plan.down.push(createIndex(live.name, asDeclared(recorded)));
  }
}
