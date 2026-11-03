// Single responsibility: which foreign keys a migration adds or drops, and where each statement
// goes — `constraints` AFTER the table statements, `preDrops` BEFORE them, or the deferred step for
// a key on a live table, whose add and validate would scan it under a lock that stops writes.
// `generate.ts` assembles the plan; `foreign-key.ts` writes the SQL.

import { type ConcurrentPlan, contractKey, deferKey, targetIndexDeferred } from './concurrent-plan';
import type { EntityDescriptionLike } from './entity-shape';
import {
  addForeignKey,
  dropForeignKey,
  foreignKeyTarget,
  keyId,
  onDeleteRule,
  referenceParts,
  unrestorableNote,
} from './foreign-key';
import type { ForeignKeyDescription, TableDescription } from './introspect';
import { sameTenantKeyName } from './same-tenant';

/** The two directions of one migration, pushed in `up` order; `down` is reversed at assembly. */
export interface Plan {
  readonly up: string[];
  readonly down: string[];
}

/**
 * The keys this entity declares, recorded so drift can see one dropped by hand. Recording
 * `foreignKeys: []` while the same run emitted a constraint was a snapshot claiming a constraint
 * does not exist that the migration beside it creates, and `compareTable` had nothing to compare —
 * a key dropped on the database was invisible to every check the framework runs.
 *
 * The name is `<table>_<column>_fkey` — what Postgres would have called an inline `references`
 * clause — and `addForeignKey` now writes it out, so the snapshot records a name the migration
 * beside it chose rather than one it guessed. It is still *not* what drift matches on: see
 * `compareForeignKeys` in `drift.ts`.
 *
 * `onDelete` is the column's own, and `addForeignKey` spells it: a rule recorded here while no
 * clause declared one would be a claim about the database that is not true, which is what it was
 * until the clause learned to write it out.
 *
 * A column carrying `sameTenant` is the composite `(tenant, column) -> target (tenant, target)`, under
 * a name of its own so the plain key it replaces on a live table can stand until it validates
 * (`sameTenantKeyName`). Its `set null` names the one column: bare, Postgres nulls every column of a
 * key, and that includes the tenant.
 */
export function foreignKeysOf(entity: EntityDescriptionLike): ForeignKeyDescription[] {
  return entity.columns
    .filter((column) => column.references !== null)
    .map((column): ForeignKeyDescription => {
      const [table, key] = referenceParts(column.references ?? '');
      const tenant = column.sameTenant;
      if (tenant !== null && tenant !== undefined) {
        const rule = column.onDelete ?? null;
        return {
          name: sameTenantKeyName(entity.table, column.column),
          columns: [tenant.column, column.column],
          referencedTable: table,
          referencedColumns: [tenant.targetColumn, key],
          onDelete: rule === 'set null' ? `set null (${column.column})` : rule,
        };
      }
      return {
        name: `${entity.table}_${column.column}_fkey`,
        columns: [column.column],
        referencedTable: table,
        referencedColumns: [key],
        onDelete: column.onDelete ?? null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Every foreign key the entity declares that the previous snapshot does not already record, as its
 * own `add constraint`. One call site for both cases the generator has — a table being created and
 * a `references()` added to a column that already exists — because they are one question: which of
 * this entity's keys does the database not hold yet.
 *
 * The statements land in a bucket of their own, appended after every table statement, so a key
 * never runs before the table it points at. `down` is reversed as a whole, so pushing the drops
 * last here puts them *first* on the way back: `drop table "posts"` with `comments` still
 * referencing it is `2BP01`, a migration that cannot be rolled back at all.
 *
 * The mirror image of that asymmetry is `plans.preDrops`, which is emitted BEFORE the table
 * statements: a key pointing at a table this migration DROPS has to go first, or the drop is
 * `2BP01` on the way forward. Its `down` is a comment for the same reason the table's own is —
 * `add constraint` against a table no `down` can restore is a rollback that cannot run.
 *
 * Both directions, because a snapshot may not lie: a removed `references()` used to emit nothing
 * while the snapshot beside it recorded `foreignKeys: []`, so the orphan constraint stayed on the
 * database *and* the record denied one the catalog holds — and `compareForeignKeys` judges the
 * declared side, so no drift check could ever see it. This comment used to add "not parity with a
 * removed index either: that leaves the snapshot correct by omission", which was **wrong** — a
 * removed index lied in the identical way, and `index-plan.ts` is the arm that closed it. The drop names the constraint the previous snapshot
 * recorded, never the name this generator would have chosen — a hand-written `fk_legacy` is
 * `42704` under the generated spelling.
 *
 * `plans.predropped` names the constraints a RETYPE already took out of the way (`retype-keys.ts`),
 * and it is read as "the schema does not record this key" — the same reading `checkPlan` gives its
 * own `predropped` set. That is what makes this function the one writer of an `add constraint`
 * after a retype: a key still declared is added back here, in the bucket that already runs after
 * every table statement; one the entity dropped is left where the retype left it, because dropping
 * it a second time is `42704`; and one whose `on delete` moved comes back carrying the new rule.
 * Its `down` is the retype's, pushed where reversal puts it after both ends are back.
 *
 * WHICH PHASE. A key on a table in `live` goes to the deferred step (`deferKey`): `not valid`, then
 * `validate`. So does a key on a table this migration creates whose target index only the deferred
 * step builds, since `add constraint` before that index exists is `42830`. One path for every such
 * key, whether or not its target index is new, so the question is never asked twice. Two stay
 * transactional: a key on a new table over a target that already has its index (nothing to scan,
 * byte-identical to what every table's first migration always said), and a retype's re-add, which
 * holds ACCESS EXCLUSIVE for the rewrite already, so a second pass buys nothing and costs a window
 * with no key. A recorded key whose column a deferred key now covers goes in the contract phase;
 * until then the old key still guards every write.
 */
export function foreignKeyPlan(
  entity: EntityDescriptionLike,
  live: TableDescription | undefined,
  plans: ConstraintPlans,
): void {
  const { constraints, preDrops, doomed, predropped, concurrent } = plans;
  const wanted = foreignKeysOf(entity);
  const movedByRetype = new Set(
    (live?.foreignKeys ?? [])
      .filter((key) => predropped.has(keyId(entity.table, key.name)))
      .map(foreignKeyTarget),
  );
  const deferredColumns = new Set<string>();
  const swapped = new Set<string>();
  const defer = (key: ForeignKeyDescription, recorded?: ForeignKeyDescription): void => {
    deferKey(entity.table, key, recorded, concurrent);
    for (const column of key.columns) deferredColumns.add(column);
  };
  const recordedKeys = (live?.foreignKeys ?? []).filter(
    (key) => !predropped.has(keyId(entity.table, key.name)),
  );
  const held = new Map(recordedKeys.map((key) => [foreignKeyTarget(key), key]));
  for (const key of wanted) {
    const recorded = held.get(foreignKeyTarget(key));
    if (doomed.has(key.referencedTable)) {
      // Still declared, but its target is going away this migration. The constraint cannot outlive
      // the table, so it goes first — and no `add constraint` is written for one that never was.
      if (recorded !== undefined)
        unrestorableDrop(entity.table, recorded.name, key.referencedTable, preDrops);
      continue;
    }
    if (recorded === undefined) {
      const onLiveTable = live !== undefined && !movedByRetype.has(foreignKeyTarget(key));
      if (
        onLiveTable ||
        targetIndexDeferred(concurrent, key.referencedTable, key.referencedColumns)
      ) {
        // A recorded key repointed under its own name: the one ALTER is its contract too.
        const named = recordedKeys.find((each) => each.name === key.name);
        if (named !== undefined) swapped.add(named.name);
        // Moved away from a table this migration drops: `preDrops` takes it first, and there is
        // nothing to restore it onto, so the snapshot and the `down` treat this key as new.
        defer(key, named !== undefined && doomed.has(named.referencedTable) ? undefined : named);
        continue;
      }
      constraints.up.push(addForeignKey(entity.table, key));
      constraints.down.push(dropForeignKey(entity.table, key.name));
      continue;
    }
    // The rule is not part of a key's identity, so the same key under a new one is a rebuild —
    // Postgres has no `alter constraint` for it, the same reason `redefineIndex` recreates.
    if (onDeleteRule(recorded.onDelete) === onDeleteRule(key.onDelete)) continue;
    // Under its own name the one ALTER swaps it; under another the recorded key holds till contract.
    if (recorded.name === key.name) {
      defer(key, recorded);
    } else {
      defer(key);
      contractKey(entity.table, recorded, concurrent);
    }
  }
  const declared = new Set(wanted.map(foreignKeyTarget));
  const columns = new Set(entity.columns.map((column) => column.column));
  for (const key of recordedKeys) {
    if (declared.has(foreignKeyTarget(key))) continue;
    // `drop column` takes the constraint with it, so a `drop constraint` after that statement is
    // `42704` on a constraint that is already gone.
    if (!key.columns.every((column) => columns.has(column))) continue;
    if (doomed.has(key.referencedTable)) {
      unrestorableDrop(entity.table, key.name, key.referencedTable, preDrops);
      continue;
    }
    if (swapped.has(key.name)) continue;
    if (key.columns.some((column) => deferredColumns.has(column))) {
      contractKey(entity.table, key, concurrent);
      continue;
    }
    constraints.up.push(dropForeignKey(entity.table, key.name));
    constraints.down.push(addForeignKey(entity.table, key));
  }
}

export interface ConstraintPlans {
  /** `add`/`drop` for keys between tables that survive — appended AFTER the table statements. */
  readonly constraints: Plan;
  /** Keys pointing at a table this migration drops — emitted BEFORE the table statements. */
  readonly preDrops: Plan;
  /** The tables this migration drops, by name. */
  readonly doomed: ReadonlySet<string>;
  /**
   * Recorded keys a retype already dropped ahead of the ALTERs, by `keyId` (`retype-keys.ts`).
   * Read as "not recorded", never as "leave it alone": the declared side still needs its
   * `add constraint`, and it is this function that writes it.
   */
  readonly predropped: ReadonlySet<string>;
  /**
   * The deferred step. Filled by every table's `diffTable` BEFORE this function runs for any table,
   * since a key's own table says nothing about whether its target's index is deferred.
   */
  readonly concurrent: ConcurrentPlan;
}

/**
 * A key whose target is being dropped: gone on the way up, a note on the way back.
 *
 * The note itself is `unrestorableNote` (`foreign-key.ts`) and not a string built here —
 * `retype-keys.ts` says the same thing about the same failed rollback, and two spellings of one
 * fact is whichever module emitted last deciding what an operator reads.
 */
function unrestorableDrop(table: string, constraint: string, target: string, preDrops: Plan): void {
  preDrops.up.push(dropForeignKey(table, constraint));
  preDrops.down.push(unrestorableNote(table, constraint, target));
}
