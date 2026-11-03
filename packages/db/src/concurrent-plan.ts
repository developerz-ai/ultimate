// Single responsibility: the work `x db gen` moves OUT of the migration's transaction into a step
// of its own — `concurrently: true` builds and index removals (`index-plan.ts` decides which), plus
// live-table foreign keys and CHECK validation (`foreign-key-plan.ts`, `check-ddl.ts`), each an
// outage under a lock that stops writes. It writes the statements and the intermediate snapshot.

import type { IndexDescriptionLike } from './entity-shape';
import {
  dropForeignKeyIfExists,
  replaceForeignKeyNotValid,
  validateConstraint,
} from './foreign-key';
import type { Plan } from './foreign-key-plan';
import {
  asDeclared,
  createIndex,
  dropIndexConcurrently,
  indexShape,
  mayBeConstraintBacked,
} from './index-ddl';
import type { ForeignKeyDescription, IndexDescription, SchemaDescription } from './introspect';
import { identifier } from './sql';

/**
 * One index the non-transactional step changes: `recorded` is what stood there before it (absent
 * for a new build) — what the transactional step's snapshot still records (`intermediateSnapshot`).
 */
export interface DeferredIndex {
  readonly table: string;
  readonly name: string;
  readonly recorded?: IndexDescription | undefined;
  /**
   * What the step builds, absent for a removal: a foreign key over exactly these columns cannot be
   * added before the step, or the transactional step answers `42830` (`targetIndexDeferred`).
   */
  readonly builds?: { readonly columns: readonly string[]; readonly unique: boolean } | undefined;
}

/**
 * One key the non-transactional step changes: `recorded` is what the transactional step's snapshot
 * still records under this name (absent for a new key). The `DeferredIndex` of a constraint, and
 * for the same reason: a failed second step must not leave a ledger claiming a key the catalog lacks.
 */
export interface DeferredKey {
  readonly table: string;
  readonly name: string;
  readonly recorded?: ForeignKeyDescription | undefined;
}

/**
 * The non-transactional step's statements, in phases, and what each changes for the snapshot.
 * `up`/`down` EXPAND (every build), `keys` adds each key `not valid`, `validate` scans the rows they
 * let stand, and `contractKeys` then `contract` CONTRACT (every removal): each phase finishes before
 * the next starts, so a replacement exists before what it replaces goes — across tables too, since
 * the phases are joined once, at assembly (`stepStatements`).
 */
export interface ConcurrentPlan extends Plan {
  readonly contract: string[];
  readonly contractDown: string[];
  readonly deferred: DeferredIndex[];
  readonly keys: string[];
  readonly keysDown: string[];
  readonly validate: string[];
  /** A dropped key goes before a dropped index: the key may be what still needs that index. */
  readonly contractKeys: string[];
  readonly contractKeysDown: string[];
  readonly deferredKeys: DeferredKey[];
}

export const emptyConcurrentPlan = (): ConcurrentPlan => ({
  up: [],
  down: [],
  contract: [],
  contractDown: [],
  deferred: [],
  keys: [],
  keysDown: [],
  validate: [],
  contractKeys: [],
  contractKeysDown: [],
  deferredKeys: [],
});

/**
 * The step's script in apply order — index builds, key adds, validates, contract — and its reversal:
 * what was removed is restored FIRST, then what is new dropped, so the reversal has no gap either.
 * A `validate` has no reversal: un-validating a constraint nobody asked to weaken undoes nothing.
 */
export function stepStatements(plan: ConcurrentPlan): {
  readonly up: readonly string[];
  readonly down: readonly string[];
} {
  return {
    up: [...plan.up, ...plan.keys, ...plan.validate, ...plan.contractKeys, ...plan.contract],
    down: [
      ...plan.down,
      ...plan.keysDown,
      ...plan.contractKeysDown,
      ...plan.contractDown,
    ].reverse(),
  };
}

/** A declared index this migration builds new, concurrently, with its concurrent drop as `down`. */
export function buildConcurrently(
  table: string,
  index: IndexDescriptionLike,
  concurrent: ConcurrentPlan,
): void {
  concurrent.up.push(createIndex(table, index, true));
  concurrent.down.push(dropIndexConcurrently(index.name));
  concurrent.deferred.push({ table, name: index.name, builds: builtBy(index) });
}

const builtBy = (index: IndexDescriptionLike): NonNullable<DeferredIndex['builds']> => ({
  columns: index.columns,
  unique: index.unique,
});

/**
 * Whether the unique index a key over `columns` of `table` needs is one this step builds. Column
 * sets, not lists: Postgres matches a key to a unique index whichever way round either spells them.
 */
export function targetIndexDeferred(
  concurrent: ConcurrentPlan,
  table: string,
  columns: readonly string[],
): boolean {
  const wanted = new Set(columns);
  return concurrent.deferred.some(
    ({ table: owner, builds }) =>
      owner === table &&
      builds?.unique === true &&
      builds.columns.length === wanted.size &&
      builds.columns.every((column) => wanted.has(column)),
  );
}

/**
 * Add a key without stopping writes: `not valid` then `validate`, both in the deferred step.
 * `recorded` is the key this one replaces under the SAME name, which the one ALTER swaps with no
 * gap; a key under another name stays up until `contractKey`, in the contract phase.
 */
export function deferKey(
  table: string,
  key: ForeignKeyDescription,
  recorded: ForeignKeyDescription | undefined,
  concurrent: ConcurrentPlan,
): void {
  concurrent.keys.push(replaceForeignKeyNotValid(table, key));
  concurrent.validate.push(validateConstraint(table, key.name));
  // Pushed forwards and read backwards, like every `down`: the rebuild lands before its validate.
  if (recorded === undefined) {
    concurrent.keysDown.push(dropForeignKeyIfExists(table, key.name));
  } else {
    concurrent.keysDown.push(
      validateConstraint(table, key.name),
      replaceForeignKeyNotValid(table, recorded),
    );
  }
  concurrent.deferredKeys.push({ table, name: key.name, recorded });
}

/** A recorded key the step's new keys replace: dropped last, restored first on the way back. */
export function contractKey(
  table: string,
  recorded: ForeignKeyDescription,
  concurrent: ConcurrentPlan,
): void {
  concurrent.contractKeys.push(dropForeignKeyIfExists(table, recorded.name));
  concurrent.contractKeysDown.push(
    validateConstraint(table, recorded.name),
    replaceForeignKeyNotValid(table, recorded),
  );
  concurrent.deferredKeys.push({ table, name: recorded.name, recorded });
}

/** A constraint the transaction added `not valid`: its scan runs here, after the commit. */
export function deferValidate(table: string, name: string, concurrent: ConcurrentPlan): void {
  concurrent.validate.push(validateConstraint(table, name));
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
 * So the shape `mayBeConstraintBacked` cannot rule out is first unhooked by the ALTER, and the
 * concurrent drop after it is then a no-op notice or the whole job. Constraint first: reversed,
 * the drop reaches a constraint's index and is the 2BP01 this exists to avoid.
 *
 * Both in the SAME non-transactional step, and in the phase `into` names. Never the ALTER in the
 * transactional step before it: that step's `down` cannot restore a constraint, so a rollback after
 * a failed concurrent step left the table with no uniqueness at all — and it would unhook the old
 * key before a concurrent replacement existed, letting in the duplicates that then fail its build.
 * The ALTER takes ACCESS EXCLUSIVE, so the runner gives a statement like it a transaction of its
 * own under `lock_timeout` (`migration-step.ts`); the concurrent drop stays unbounded.
 */
function dropRecordedConcurrently(table: string, recorded: IndexDescription, into: string[]): void {
  if (mayBeConstraintBacked(recorded)) {
    into.push(
      `alter table ${identifier(table).text} drop constraint if exists ${identifier(recorded.name).text};`,
    );
  }
  into.push(dropIndexConcurrently(recorded.name));
}

/**
 * A recorded index no entity declares any more: dropped concurrently, and restored by `down` —
 * concurrently too — from what the SNAPSHOT recorded, never from the entity that stopped declaring it.
 */
export function removeConcurrently(
  table: string,
  recorded: IndexDescription,
  concurrent: ConcurrentPlan,
): void {
  dropRecordedConcurrently(table, recorded, concurrent.contract);
  concurrent.contractDown.push(createIndex(table, asDeclared(recorded), true));
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
  concurrent: ConcurrentPlan,
): void {
  if (indexShape(index) === indexShape(recorded)) return;
  // One name, so no expand → contract is possible: the drop must precede the build, in the
  // expand phase, in that order.
  dropRecordedConcurrently(table, recorded, concurrent.up);
  concurrent.up.push(createIndex(table, index, true));
  // Pushed forwards and read backwards, as `redefineIndex`'s: the recorded definition lands last.
  concurrent.down.push(
    createIndex(table, asDeclared(recorded), true),
    dropIndexConcurrently(index.name),
  );
  concurrent.deferred.push({ table, name: index.name, recorded, builds: builtBy(index) });
}

/**
 * The schema the TRANSACTIONAL step leaves behind when a non-transactional one follows it: the
 * final snapshot with every deferred index put back the way it was — gone if it is new, its
 * recorded definition if it is removed or rebuilt. The sidecar is "the schema this migration leaves
 * behind", and a database that applied the first step alone holds exactly this: the first step
 * removes no index and unhooks no constraint, so every recorded one is still there. A deferred key
 * reads the same way: lacking while new, its recorded definition while replaced or contracted.
 */
export function intermediateSnapshot(
  final: SchemaDescription,
  deferred: readonly DeferredIndex[],
  deferredKeys: readonly DeferredKey[] = [],
): SchemaDescription {
  return {
    tables: final.tables.map((table) => {
      const mine = deferred.filter((each) => each.table === table.name);
      const keys = deferredKeys.filter((each) => each.table === table.name);
      if (mine.length === 0 && keys.length === 0) return table;
      const names = new Set(mine.map((each) => each.name));
      const keyNames = new Set(keys.map((each) => each.name));
      return {
        ...table,
        indexes: [
          ...table.indexes.filter((index) => !names.has(index.name)),
          ...mine.flatMap((each) => (each.recorded === undefined ? [] : [each.recorded])),
        ],
        foreignKeys: [
          ...table.foreignKeys.filter((key) => !keyNames.has(key.name)),
          ...keys.flatMap((each) => (each.recorded === undefined ? [] : [each.recorded])),
        ].sort((a, b) => (a.name < b.name ? -1 : 1)),
      };
    }),
  };
}
