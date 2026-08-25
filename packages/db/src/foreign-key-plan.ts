// Single responsibility: which foreign keys a migration must add or drop, and into which of the
// two buckets each statement goes — `constraints` runs AFTER the table statements, `preDrops`
// BEFORE them. `generate.ts` assembles the plan; `foreign-key.ts` writes the SQL.

import type { EntityDescriptionLike } from './entity-shape';
import { addForeignKey, dropForeignKey, foreignKeyTarget, onDeleteRule } from './foreign-key';
import type { ForeignKeyDescription, TableDescription } from './introspect';
import { identifier } from './sql';

/** The two directions of one migration, pushed in `up` order; `down` is reversed at assembly. */
export interface Plan {
  readonly up: string[];
  readonly down: string[];
}

/**
 * The two ends of a `references()`, which entity renders as `"<table>.<column>"`. Read once: the
 * clause that writes the constraint and the snapshot that records it must not disagree about what
 * it points at, or drift reports a key the database holds exactly as declared.
 */
export function referenceParts(references: string): readonly [string, string] {
  const [table = references, column = 'id'] = references.split('.');
  return [table, column];
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
 */
export function foreignKeysOf(entity: EntityDescriptionLike): ForeignKeyDescription[] {
  return entity.columns
    .filter((column) => column.references !== null)
    .map((column): ForeignKeyDescription => {
      const [table, key] = referenceParts(column.references ?? '');
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
 * declared side, so no drift check could ever see it. Not parity with a removed index either: that
 * leaves the snapshot correct by omission. The drop names the constraint the previous snapshot
 * recorded, never the name this generator would have chosen — a hand-written `fk_legacy` is
 * `42704` under the generated spelling.
 */
export function foreignKeyPlan(
  entity: EntityDescriptionLike,
  live: TableDescription | undefined,
  plans: ConstraintPlans,
): void {
  const { constraints, preDrops, doomed } = plans;
  const wanted = foreignKeysOf(entity);
  const held = new Map((live?.foreignKeys ?? []).map((key) => [foreignKeyTarget(key), key]));
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
      constraints.up.push(addForeignKey(entity.table, key));
      constraints.down.push(dropForeignKey(entity.table, key.name));
      continue;
    }
    // The rule is not part of a key's identity, so the same key under a new one is a rebuild —
    // Postgres has no `alter constraint` for it, the same reason `redefineIndex` recreates.
    if (onDeleteRule(recorded.onDelete) === onDeleteRule(key.onDelete)) continue;
    constraints.up.push(
      dropForeignKey(entity.table, recorded.name),
      addForeignKey(entity.table, key),
    );
    // Pushed forwards and read backwards, like `redefineIndex`: `down` is reversed at assembly.
    constraints.down.push(
      addForeignKey(entity.table, recorded),
      dropForeignKey(entity.table, key.name),
    );
  }
  const declared = new Set(wanted.map(foreignKeyTarget));
  const columns = new Set(entity.columns.map((column) => column.column));
  for (const key of live?.foreignKeys ?? []) {
    if (declared.has(foreignKeyTarget(key))) continue;
    // `drop column` takes the constraint with it, so a `drop constraint` after that statement is
    // `42704` on a constraint that is already gone.
    if (!key.columns.every((column) => columns.has(column))) continue;
    if (doomed.has(key.referencedTable)) {
      unrestorableDrop(entity.table, key.name, key.referencedTable, preDrops);
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
}

/**
 * A key whose target is being dropped: gone on the way up, a note on the way back.
 *
 * The note goes through `identifier` too. A `--` comment ends at the first newline, so a name
 * holding one is a second command on the line after it — the same escape `columnClause` closed,
 * one quoting rule short of the statement above it.
 */
function unrestorableDrop(table: string, constraint: string, target: string, preDrops: Plan): void {
  preDrops.up.push(dropForeignKey(table, constraint));
  preDrops.down.push(
    `-- constraint ${identifier(constraint).text} on ${identifier(table).text} ` +
      `cannot be restored; ${identifier(target).text} is gone`,
  );
}
