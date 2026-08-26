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
import { identifier } from './sql';

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

/**
 * The one `fix:` here whose second layer no quoting closes. `x db gen "add C"` puts the column
 * inside SHELL DOUBLE QUOTES, where `$(…)` and a backtick substitute before `x` is reached at all
 * — and the argument is a migration DESCRIPTION, not an identifier, so there is no quoted form
 * that would make a hostile name safe to pass. A name `writableName` refuses is therefore left out
 * of the command rather than escaped into it: the command still runs and still generates the
 * migration, and the name is read off `cause` and `column`, which are prose nobody pastes.
 */
export function unexpectedColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'unexpected-column',
    table,
    column,
    // Pinned by the contract. Do not reword without changing docs/errors/X_DB_DRIFT.
    cause: `table "${table}" has column "${column}" not present in any migration`,
    fix:
      writableName(column) === null
        ? 'x db gen "add the undeclared column"   # the live column name carries a backtick, a ' +
          'dollar sign, a quote, a backslash or whitespace, so it is in the cause and not in ' +
          'this command'
        : `x db gen "add ${column}"`,
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
  const relation = writableName(table);
  const attribute = writableName(column);
  return {
    kind: 'changed-column',
    table,
    column,
    cause: liveNullable
      ? `table "${table}" allows NULL in column "${column}" that migrations declare not null`
      : `table "${table}" forbids NULL in column "${column}" that migrations declare nullable`,
    // Both identifiers are the catalog's, so both go through the one screen. A refusal names the
    // column as the thing it could not spell, which is what tells this line apart from
    // `missingCheck`'s refusal in a report that carries both.
    fix:
      relation === null || attribute === null
        ? `${clause} on the column named in this difference, in a new migration, then ` +
          'x db migrate — its table or column name carries a backtick, a dollar sign, a quote, ' +
          'a backslash or whitespace, so no statement here can spell it'
        : `alter table ${relation} alter column ${attribute} ${clause};   # in a new migration` +
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
  const name = writableName(table);
  return {
    kind: 'unexpected-table',
    table,
    column: null,
    cause: `table "${table}" is not present in any migration`,
    fix:
      name === null
        ? 'claim it in a migration with create table if not exists, or drop it by hand — its ' +
          'table name carries a backtick, a dollar sign, a quote, a backslash or whitespace, so ' +
          'no statement here can spell it'
        : `put a create table if not exists ${name} (…) statement in a migration — x db migrate ` +
          'then accepts a table its own SQL creates — or, if nothing owns it, run ' +
          `drop table ${name}; inside psql "$DATABASE_URL"`,
  };
}

/**
 * The ONE screen every `fix:` on this page puts a catalog name through: the quoted identifier a
 * statement may carry, or `null` for a name no line here may spell.
 *
 * The name is DATA — `unexpected-table` is by definition a relation nothing here created, and
 * `create table "x""; drop table users; --" ("id" int)` is legal DDL, so whoever can create a
 * table or a column picks the text that lands in a `fix:`. `identifier` is the rule
 * `foreign-key.ts` states for every name this package writes, and a refusal degrades to prose the
 * way `rebuildForeignKey`'s does: a fix naming no command beats one running a second command the
 * reader never read.
 *
 * TWO layers, and `identifier` closes only the first. A `fix:` is pasted into a SHELL at least as
 * often as into a migration, and `identifier` answers about SQL: it refuses `"`, `\` and
 * whitespace, and accepts a backtick and a `$`, which are exactly the two characters a shell
 * substitutes INSIDE DOUBLE QUOTES. `unexpectedColumn`'s `x db gen "add C"` is that context and no
 * quoting rescues it, because the argument is a description and not an identifier — so the screen
 * is `identifier` AND those two, once, here, rather than a second predicate per context.
 *
 * `'` is deliberately NOT refused: it is legal in an identifier, it is inert in a psql session and
 * inside shell double quotes, and no line on this page puts a name inside shell SINGLE quotes any
 * more — `unexpectedTable`'s drop names `psql` and leaves the statement outside it, where a
 * `-c '…'` payload used to end early and hand the rest to the shell. The price of the two that ARE
 * refused is a legal `a$b` losing its executable fix line, which is a fix that reads as prose
 * rather than a fix that runs something nobody read.
 */
const SHELL_ACTIVE = /[`$]/;

function writableName(name: string): string | null {
  if (SHELL_ACTIVE.test(name)) return null;
  try {
    return identifier(name).text;
  } catch {
    return null;
  }
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
  const relation = writableName(table);
  const constraint = writableName(check.name);
  return {
    kind: 'missing-check',
    table,
    column: null,
    cause: `table "${table}" is missing check constraint "${check.name}" that migrations declare`,
    // The command rides on the same line as the statement, and not only because `check` is a
    // banned advice word the `errors` gate demands a command beside: writing the migration is half
    // the repair and applying it is the other half, and `changedColumn`'s bare `# in a new
    // migration` leaves the second half to be guessed.
    //
    // Both NAMES go through the one screen; the EXPRESSION deliberately does not, and cannot. It
    // is a predicate, so no screen could accept `status in ('draft', 'published')` and reject a
    // second statement — and it is the DECLARED side's own text, out of the author's migration,
    // where both names are the catalog's and a sidecar's. Narrower than "this line is safe", and
    // it is the honest claim.
    fix:
      relation === null || constraint === null
        ? 'add the constraint named in this difference back in a new migration, then ' +
          'x db migrate — its table or constraint name carries a backtick, a dollar sign, a ' +
          'quote, a backslash or whitespace, so no statement here can spell it'
        : `alter table ${relation} add constraint ${constraint} ` +
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
