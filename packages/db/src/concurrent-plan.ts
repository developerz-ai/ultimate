// Single responsibility: the index work `x db gen` moves OUT of the migration's transaction into a
// step of its own — every `concurrently: true` build and every index REMOVAL, whose concurrent
// forms queue no read and no write, and which Postgres runs only outside a transaction block.
// `index-plan.ts` decides which; this file writes the statements and the intermediate snapshot.

import type { IndexDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import {
  asDeclared,
  createIndex,
  dropIndexConcurrently,
  indexShape,
  mayBeConstraintBacked,
} from './index-ddl';
import type { IndexDescription, SchemaDescription } from './introspect';
import { identifier } from './sql';

/**
 * One index the non-transactional step changes: `recorded` is what stood there before it (absent
 * for a new build) — what the transactional step's snapshot still records (`intermediateSnapshot`).
 */
export interface DeferredIndex {
  readonly table: string;
  readonly name: string;
  readonly recorded?: IndexDescription | undefined;
}

/** The non-transactional step's statements, and what each one changes for the snapshot. */
export interface ConcurrentPlan extends Plan {
  readonly deferred: DeferredIndex[];
}

export const emptyConcurrentPlan = (): ConcurrentPlan => ({ up: [], down: [], deferred: [] });

/** A declared index this migration builds new, concurrently, with its concurrent drop as `down`. */
export function buildConcurrently(
  table: string,
  index: IndexDescriptionLike,
  concurrent: ConcurrentPlan,
): void {
  concurrent.up.push(createIndex(table, index, true));
  concurrent.down.push(dropIndexConcurrently(index.name));
  concurrent.deferred.push({ table, name: index.name });
}

/**
 * Drop a RECORDED index whose kind this generator cannot know, in statements that are correct on
 * both databases it cannot tell apart.
 *
 * `TableDescription` carries no discriminator, and it cannot be given one that would help: the
 * SAME declaration reaches the server as a CONSTRAINT or as an INDEX depending on which migration
 * created it. A `unique` column on a table `createTable` writes emits `create table … slug text
 * unique`, and Postgres backs that with a constraint named `posts_slug_key`; the same column
 * gaining `unique` later takes `create unique index "posts_slug_key"` and is a plain index.
 * `snapshotOf` records both as `{ unique: true, primary: false }`.
 *
 * Measured on 18.4 (`index-removal.live.test.ts`), which is why the pair and not a guess:
 *
 * | statement                                    | on a constraint's index    | on a plain index |
 * |----------------------------------------------|----------------------------|------------------|
 * | `drop index [if exists] "n"`                 | **2BP01** — not suppressed | ok               |
 * | `drop index concurrently if exists "n"`      | **2BP01** — not suppressed | ok               |
 * | `alter table … drop constraint if exists`    | drops it, index and all    | notice, no-op    |
 *
 * So the shape `mayBeConstraintBacked` cannot rule out is first unhooked inside the TRANSACTIONAL
 * step — under its `lock_timeout`, because that ALTER takes ACCESS EXCLUSIVE whichever kind it
 * meets — and the concurrent drop after it is then a no-op notice or the whole job. Constraint
 * first: reversed, the drop reaches a constraint's index and is the 2BP01 this exists to avoid.
 */
function dropRecordedConcurrently(
  table: string,
  recorded: IndexDescription,
  plan: Plan,
  concurrent: ConcurrentPlan,
): void {
  if (mayBeConstraintBacked(recorded)) {
    plan.up.push(
      `alter table ${identifier(table).text} drop constraint if exists ${identifier(recorded.name).text};`,
    );
  }
  concurrent.up.push(dropIndexConcurrently(recorded.name));
}

/**
 * A recorded index no entity declares any more: dropped concurrently, and restored by `down` —
 * concurrently too — from what the SNAPSHOT recorded, never from the entity that stopped declaring it.
 */
export function removeConcurrently(
  table: string,
  recorded: IndexDescription,
  plan: Plan,
  concurrent: ConcurrentPlan,
): void {
  dropRecordedConcurrently(table, recorded, plan, concurrent);
  concurrent.down.push(createIndex(table, asDeclared(recorded), true));
  concurrent.deferred.push({ table, name: recorded.name, recorded });
}

/**
 * A `concurrently: true` index whose definition moved: dropped and rebuilt, both concurrently —
 * `redefineIndex`'s pair outside the transaction. Between the two statements the table has neither
 * definition; for a unique index that is a window with no uniqueness, the price of never blocking a
 * write (name the new shape differently to build it beside the old one instead).
 */
export function redefineConcurrently(
  table: string,
  index: IndexDescriptionLike,
  recorded: IndexDescription,
  plan: Plan,
  concurrent: ConcurrentPlan,
): void {
  if (indexShape(index) === indexShape(recorded)) return;
  dropRecordedConcurrently(table, recorded, plan, concurrent);
  concurrent.up.push(createIndex(table, index, true));
  // Pushed forwards and read backwards, as `redefineIndex`'s: the recorded definition lands last.
  concurrent.down.push(
    createIndex(table, asDeclared(recorded), true),
    dropIndexConcurrently(index.name),
  );
  concurrent.deferred.push({ table, name: index.name, recorded });
}

/**
 * The schema the TRANSACTIONAL step leaves behind when a non-transactional one follows it: the
 * final snapshot with every deferred index put back the way it was — gone if it is new, its
 * recorded definition if it is removed or rebuilt. The sidecar is "the schema this migration leaves
 * behind", and a database that applied the first step alone holds exactly this.
 */
export function intermediateSnapshot(
  final: SchemaDescription,
  deferred: readonly DeferredIndex[],
): SchemaDescription {
  return {
    tables: final.tables.map((table) => {
      const mine = deferred.filter((each) => each.table === table.name);
      if (mine.length === 0) return table;
      const names = new Set(mine.map((each) => each.name));
      return {
        ...table,
        indexes: [
          ...table.indexes.filter((index) => !names.has(index.name)),
          ...mine.flatMap((each) => (each.recorded === undefined ? [] : [each.recorded])),
        ],
      };
    }),
  };
}
