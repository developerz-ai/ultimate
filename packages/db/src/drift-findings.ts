// Single responsibility: what a schema difference is CALLED and what its `fix:` line says — one
// constructor per `DriftKind`, and nothing that compares anything. Split out of `drift.ts` at the
// 500-line ceiling, along the seam that file already drew: comparison decides *whether* two
// schemas disagree, and this decides how the disagreement reads.
//
// The rendered `X_DB_DRIFT` output is byte-for-byte pinned by the framework contract and
// duplicated in `@ultimat3/entity` — do not reword a `cause` without changing both.
//
// Two rules run through every one of them. A `fix:` is a command the reader can RUN: `x db
// migrate` where the migration has not been applied, and the statement itself where it has, since
// re-running the migrator applies nothing a ledger row already claims. And a difference names the
// declared side's own spelling, never the catalog's, because the catalog's is Postgres' rewriting.

import { onDeleteRule, rebuildForeignKey } from './foreign-key';
import type { CheckDescription, ForeignKeyDescription } from './introspect';
import type { Migration } from './migrate';

export type DriftKind =
  | 'unexpected-column'
  | 'missing-column'
  | 'changed-column'
  | 'unexpected-table'
  | 'missing-table'
  | 'unknown-schema'
  | 'missing-index'
  | 'changed-index'
  | 'missing-check'
  | 'missing-foreign-key'
  | 'changed-foreign-key';

export interface DriftDifference {
  readonly kind: DriftKind;
  readonly table: string;
  readonly column: string | null;
  readonly cause: string;
  readonly fix: string;
}

export interface DriftReport {
  readonly ok: boolean;
  readonly differences: readonly DriftDifference[];
}

export function unexpectedColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'unexpected-column',
    table,
    column,
    // Pinned by the contract. Do not reword without changing docs/errors/X_DB_DRIFT.
    cause: `table "${table}" has column "${column}" not present in any migration`,
    fix: `x db gen "add ${column}"`,
  };
}

export function missingColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'missing-column',
    table,
    column,
    cause: `table "${table}" is missing column "${column}" that migrations declare`,
    fix: 'x db migrate',
  };
}

/**
 * The column exists on both sides and one of them lets it be `NULL`.
 *
 * This is the finding the expand/contract flow needs and never had. `generate.ts` emits a `NOT
 * NULL` add as nullable plus a `-- backfill "c", then: … set not null;` comment, because the
 * strict version cannot succeed on a populated table — and phase 2 is a comment, so it is a thing
 * a human has to remember. Nobody did, and `compareTable` compared columns by name and by type
 * while `snapshotOf` had recorded `nullable` all along, so the column stayed nullable forever
 * against an entity schema that said otherwise, with `ok: true` on every check. The first
 * `undefined` write then lands as `NULL` and crashes three services away from the migration.
 *
 * `x db gen` is deliberately not the fix: it diffs types and indexes and has never emitted a
 * `set not null`, so naming it would send a reader to a command that generates an empty migration.
 */
export function changedColumn(
  table: string,
  column: string,
  liveNullable: boolean,
): DriftDifference {
  const clause = liveNullable ? 'set not null' : 'drop not null';
  return {
    kind: 'changed-column',
    table,
    column,
    cause: liveNullable
      ? `table "${table}" allows NULL in column "${column}" that migrations declare not null`
      : `table "${table}" forbids NULL in column "${column}" that migrations declare nullable`,
    fix:
      `alter table "${table}" alter column "${column}" ${clause};   # in a new migration` +
      (liveNullable ? ' — backfill the existing NULLs first' : ''),
  };
}

/**
 * The `fix:` names the two edits that actually resolve this, and neither is `x db gen` (issue
 * #345). That command diffs the ENTITY REGISTRY against the newest snapshot, and a table nothing
 * declares is absent from both sides of that diff — so it wrote an EMPTY migration, and the
 * generator's own empty-diff branch writes no file at all, leaving the reader with nothing to run
 * and the same finding on the next deploy.
 *
 * What is left once `@ultimat3/cli`'s `acceptCreatedTables` has run is a table no migration's SQL
 * creates and no entity declares — so either a migration should claim it (`if not exists`, because
 * the relation is already there, and `x db migrate` then accepts a table its own SQL creates), or
 * nothing owns it and it should not be in this schema. No migration PATH is named: where an app
 * keeps its migrations is the CLI's fact, not this package's.
 */
export function unexpectedTable(table: string): DriftDifference {
  return {
    kind: 'unexpected-table',
    table,
    column: null,
    cause: `table "${table}" is not present in any migration`,
    fix: `put a create table if not exists "${table}" (…) statement in a migration — x db migrate then accepts a table its own SQL creates — or, if nothing owns it: psql "$DATABASE_URL" -c 'drop table "${table}"'`,
  };
}

export function missingTable(table: string): DriftDifference {
  return {
    kind: 'missing-table',
    table,
    column: null,
    cause: `table "${table}" is declared by migrations but does not exist`,
    fix: 'x db migrate',
  };
}

/**
 * Not a difference between two schemas but the absence of one to compare against — reported
 * through the same channel so it reaches an operator, since a check that quietly answered "clean"
 * because it had nothing to check is the one failure mode drift detection cannot have.
 */
export function unknownSchema(migrations: readonly Migration[]): DriftDifference {
  const newest = [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
  return {
    kind: 'unknown-schema',
    table: '',
    column: null,
    cause:
      `migration "${newest?.id ?? ''}" records no schema snapshot, so what this database owes ` +
      'cannot be established',
    // The same two remedies `X_MIGRATION_SNAPSHOT_MISSING` names, in the same order, because it is
    // the same condition. It used to lead with `x db gen`, which raises that error and whose own
    // fix pointed back here — a cycle a scaffolded app hit on its first `x db migrate`. The
    // pathspec is a glob because this package is tier 1: only `@ultimat3/cli` knows the directory.
    fix:
      `git checkout -- "*${newest?.id ?? ''}.snapshot.json"   # or, if it was never written: ` +
      `delete migration "${newest?.id ?? ''}" and rerun x db gen "${newest?.name ?? 'initial'}"`,
  };
}

export function missingIndex(table: string, index: string): DriftDifference {
  return {
    kind: 'missing-index',
    table,
    column: null,
    cause: `table "${table}" is missing index "${index}" that migrations declare`,
    fix: 'x db migrate',
  };
}

export function changedIndex(table: string, index: string, detail: string): DriftDifference {
  return {
    kind: 'changed-index',
    table,
    column: null,
    cause: `index "${index}" on "${table}" ${detail}, not what migrations declare`,
    fix: 'x db migrate',
  };
}

/**
 * A CHECK a migration declares and the catalog does not hold.
 *
 * There is no `changed-check` beside it and there never will be, for the reason
 * `IndexDescription.where` gives: `pg_get_constraintdef` answers Postgres' own rewriting —
 * `status in ('draft','published')` reads back as `CHECK ((status = ANY (ARRAY['draft'::text,
 * 'published'::text])))` — so a text comparison reports drift on a correct database forever, and
 * normalising it is an expression parser competing with the server's. Presence is not text.
 *
 * The `fix` is the statement, not `x db migrate`: the migration that declares this constraint is
 * already in the ledger, so re-running the migrator applies nothing. Same reasoning as
 * `changedColumn` and `changedForeignKey` — the declared side holds the author's own spelling of
 * the predicate, which is what makes an executable fix possible at all.
 */
export function missingCheck(table: string, check: CheckDescription): DriftDifference {
  return {
    kind: 'missing-check',
    table,
    column: null,
    cause: `table "${table}" is missing check constraint "${check.name}" that migrations declare`,
    // The command rides on the same line as the statement, and not only because `check` is a
    // banned advice word the `errors` gate demands a command beside: writing the migration is half
    // the repair and applying it is the other half, and `changedColumn`'s bare `# in a new
    // migration` leaves the second half to be guessed.
    fix:
      `alter table "${table}" add constraint "${check.name}" ` +
      `check (${check.expression});   # in a new migration, then x db migrate`,
  };
}

export function missingForeignKey(table: string, key: ForeignKeyDescription): DriftDifference {
  return {
    kind: 'missing-foreign-key',
    table,
    column: null,
    cause:
      `table "${table}" has no foreign key on (${key.columns.join(', ')}) to ` +
      `"${key.referencedTable}" (${key.referencedColumns.join(', ')}) that migrations declare`,
    fix: 'x db migrate',
  };
}

/**
 * The key points where it was declared to point and one side's `on delete` rule is not the other's
 * — reported apart from `missing-foreign-key` because it is a different repair: the constraint is
 * there, and what changed is what happens to the child rows.
 *
 * The `fix` is the pair, not `x db migrate`: a rule cannot be altered in place, `add constraint`
 * alone is `42710` on a name already taken, and no `x db gen` diff emits either statement, so
 * naming a command would send a reader to one that generates an empty migration. Same reasoning
 * as `changedColumn`.
 */
export function changedForeignKey(
  table: string,
  declared: ForeignKeyDescription,
  held: ForeignKeyDescription,
): DriftDifference {
  const rule = onDeleteRule(held.onDelete);
  return {
    kind: 'changed-foreign-key',
    table,
    column: null,
    cause:
      `foreign key on "${table}" (${declared.columns.join(', ')}) to ` +
      `"${declared.referencedTable}" ` +
      `${rule === null ? 'declares no on delete rule' : `is on delete ${rule}`}, not what ` +
      'migrations declare',
    fix: `${rebuildForeignKey(table, declared, held)}   # in a new migration`,
  };
}
