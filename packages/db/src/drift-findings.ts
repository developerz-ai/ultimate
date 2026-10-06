// Single responsibility: what a schema difference is CALLED and what its `fix:` says — one
// constructor per `DriftKind`, and nothing that compares anything (`drift.ts` decides whether two
// schemas disagree). A `fix:` is ONE command a shell runs, and a difference names the declared
// side's spelling, never the catalog's — which is Postgres' rewriting.

import { psqlCommand } from './dependent-view';
import { addForeignKey, dropForeignKey, onDeleteRule } from './foreign-key';
import type { CheckDescription, ForeignKeyDescription } from './introspect';
import type { Migration } from './migrate';
import { addPrimaryKey, dropPrimaryKey } from './primary-key';
import { shellInertIdentifier } from './sql';

export type DriftKind =
  | 'unexpected-column'
  | 'missing-column'
  | 'changed-column'
  | 'unexpected-table'
  | 'missing-table'
  | 'unknown-schema'
  | 'missing-index'
  | 'changed-index'
  | 'changed-primary-key'
  | 'missing-check'
  | 'missing-foreign-key'
  | 'changed-foreign-key'
  // Constructed in `drift-append-only.ts`: an `appendOnly` table whose refusing trigger is gone.
  | 'missing-append-only-trigger'
  // Constructed in `object-drift.ts`: a trigger, function, view, type or sequence in the live
  // database that replaying the migrations does not create.
  | 'unexpected-object';

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

const RE_CHECK = 'then x db migrate, which re-checks';

/** `set not null` is refused by the server while a row still holds NULL, and says so here. */
const NULLS_FIRST = `refused while a row holds NULL there, so backfill those first; ${RE_CHECK}`;

const CARRIES =
  'a name in this difference carries a backtick, a dollar sign, a quote, a backslash or whitespace';

const UNSPELLABLE = `${CARRIES}, so no statement here can spell it`;

/**
 * `x db migrate` is the fix where a migration has not been applied. Where it has, re-running the
 * migrator applies nothing a ledger row already claims, so the fix is the statement itself —
 * a repair made against THIS database, as one line a shell runs: the statement is `psql`'s
 * argument (`psqlCommand`), never bare DDL beside a `#` — `#` is not a comment to Postgres and
 * `alter` is not a program to a shell, so neither reader could run that line (axiom 4). Against
 * this database and never "in a new migration": drift means this database left the migrations,
 * and a migration would re-apply the repair to every database that is already right.
 */
export const repair = (path: string, statements: string, note = RE_CHECK): string =>
  `${psqlCommand(`${path}${statements}`)}   # ${note}`;

/**
 * The same repair when no statement can be written — a name the screen refuses. Still a command
 * that runs: a psql session, with what to do in it as the comment. No name rides in it, hostile
 * or not; the `cause` holds them, and nobody pastes a cause.
 */
export const byHand = (steps: string, why = UNSPELLABLE): string =>
  `psql "$DATABASE_URL"   # ${steps}, \\q, ${RE_CHECK} — ${why}`;

/** The schema Postgres resolves an unqualified name in when a session sets nothing. */
const DEFAULT_SCHEMA = 'public';

/**
 * What puts a statement in the schema its table was READ from: nothing for the default one — the
 * text every app has seen — and `set search_path` in the same psql word for any other, so the
 * table, and every table the statement references, resolves there. A `psql "$DATABASE_URL"`
 * session starts on its own search_path: unqualified, `alter table "posts"` for a table in
 * `tenant_a` fails, or lands on a same-named table in `public`. `null` for a schema no statement
 * can spell.
 */
export const pathTo = (schema: string): string | null => {
  if (schema === DEFAULT_SCHEMA) return '';
  const name = shellInertIdentifier(schema);
  return name === null ? null : `set search_path = ${name}; `;
};

/** A table as a psql PATTERN or a statement outside `pathTo`: qualified unless the default schema. */
const qualified = (schema: string, table: string): string | null => {
  const name = shellInertIdentifier(table);
  if (name === null) return null;
  if (schema === DEFAULT_SCHEMA) return name;
  const space = shellInertIdentifier(schema);
  return space === null ? null : `${space}.${name}`;
};

/** Every name inert in a shell AND writable as an identifier — the one screen, asked of each. */
const spellable = (names: readonly string[]): boolean =>
  names.every((name) => shellInertIdentifier(name) !== null);

/**
 * The one `fix:` here whose second layer no quoting closes. `x db gen "add C"` puts the column
 * inside SHELL DOUBLE QUOTES, where `$(…)` and a backtick substitute before `x` is reached at all
 * — and the argument is a migration DESCRIPTION, not an identifier, so there is no quoted form
 * that would make a hostile name safe to pass. A name `shellInertIdentifier` (`sql.ts`) refuses
 * is therefore left out of the command rather than escaped into it: the command still runs and
 * still generates the migration, and the name is read off `cause` and `column`, which are prose
 * nobody pastes.
 */
export function unexpectedColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'unexpected-column',
    table,
    column,
    // Pinned by the contract. Do not reword without changing docs/errors/X_DB_DRIFT.
    cause: `table "${table}" has column "${column}" not present in any migration`,
    fix:
      shellInertIdentifier(column) === null
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
 * The fix is the statement, run against this database (`repair`).
 */
export function changedColumn(
  schema: string,
  table: string,
  column: string,
  liveNullable: boolean,
): DriftDifference {
  const clause = liveNullable ? 'set not null' : 'drop not null';
  const path = pathTo(schema);
  const relation = shellInertIdentifier(table);
  const attribute = shellInertIdentifier(column);
  return {
    kind: 'changed-column',
    table,
    column,
    cause: liveNullable
      ? `table "${table}" allows NULL in column "${column}" that migrations declare not null`
      : `table "${table}" forbids NULL in column "${column}" that migrations declare nullable`,
    // Both identifiers are the catalog's, so both go through the one screen.
    fix:
      path === null || relation === null || attribute === null
        ? byHand(`alter column … ${clause} on the column this difference names`)
        : repair(
            path,
            `alter table ${relation} alter column ${attribute} ${clause};`,
            liveNullable ? NULLS_FIRST : RE_CHECK,
          ),
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
 *
 * Two repairs and one line, so the line leads with the command neither repair can skip — `\\d` on
 * the table, through `psqlCommand`, which is what keeps a `'` in the name inside its shell word.
 */
export function unexpectedTable(schema: string, table: string): DriftDifference {
  const name = qualified(schema, table);
  // The comment repeats the name only when it holds no `'`: a shell that does not read `#` as a
  // comment (interactive zsh, by default) would open a quote on one. The command is safe either
  // way — `psqlCommand` escapes it inside its own word.
  const spoken = name === null || name.includes("'") ? 'this table' : name;
  return {
    kind: 'unexpected-table',
    table,
    column: null,
    cause: `table "${table}" is not present in any migration`,
    // The command is the harmless one — it SHOWS the table, which either repair needs first — and
    // the two repairs are its comment.
    fix:
      name === null
        ? byHand(
            `inspect the table this difference names with \\d, then claim it in a migration ` +
              'with create table if not exists or drop it',
          )
        : `${psqlCommand(`\\d ${name}`)}   # nothing declares it: put create table if not exists ` +
          `${spoken} (…) in a migration, then x db migrate — or, if nothing owns it, run ` +
          `drop table ${spoken}; here`,
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
  const id = newest?.id ?? '';
  const name = newest?.name ?? 'initial';
  // Both go inside SHELL DOUBLE QUOTES and both are FILENAME text — `parseMigrationSql` takes the
  // id off the file and derives the name from it — so whoever can add a file to the migrations
  // directory picks what a reader pastes, and `$(…)` and a backtick substitute before `git` or `x`
  // is reached. The same screen `unexpectedColumn` and `changedColumn` already ran, on the one
  // finding in this file that skipped it. Degraded to a read-only command rather than escaped: a glob is not an
  // identifier and a migration description is not one either, so neither has a quoted form that
  // makes a hostile name safe. An EMPTY id is inert by construction and keeps its glob — that is
  // "no migrations at all", not a name this function refused to spell.
  const spellable =
    (id === '' || shellInertIdentifier(id) !== null) && shellInertIdentifier(name) !== null;
  return {
    kind: 'unknown-schema',
    table: '',
    column: null,
    cause:
      `migration "${id}" records no schema snapshot, so what this database owes ` +
      'cannot be established',
    // The same two remedies `X_MIGRATION_SNAPSHOT_MISSING` names, in the same order, because it is
    // the same condition. It used to lead with `x db gen`, which raises that error and whose own
    // fix pointed back here — a cycle a scaffolded app hit on its first `x db migrate`. The
    // pathspec is a glob because this package is tier 1: only `@ultimat3/cli` knows the directory.
    fix: spellable
      ? `git checkout -- "*${id}.snapshot.json"   # or, if it was never written: ` +
        `delete migration "${id}" and rerun x db gen "${name}"`
      : 'git status --short -- "*.snapshot.json"   # shows the sidecar that is gone: git ' +
        'checkout it, or delete that migration and rerun x db gen with its description — the ' +
        "migration named in this difference's cause carries a backtick, a dollar sign, a " +
        'quote, a backslash or whitespace in its file name, so no command here can spell it',
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
 * The `fix` is the statement (`repair`), not `x db migrate`: the migration that declares this
 * constraint is already in the ledger, so re-running the migrator applies nothing. Same reasoning
 * as `changedColumn` and `changedForeignKey` — the declared side holds the author's own spelling
 * of the predicate, which is what makes an executable fix possible at all.
 */
export function missingCheck(
  schema: string,
  table: string,
  check: CheckDescription,
): DriftDifference {
  const path = pathTo(schema);
  const relation = shellInertIdentifier(table);
  const constraint = shellInertIdentifier(check.name);
  return {
    kind: 'missing-check',
    table,
    column: null,
    cause: `table "${table}" is missing check constraint "${check.name}" that migrations declare`,
    // Both NAMES go through the one screen; the EXPRESSION deliberately does not, and cannot. It
    // is a predicate, so no screen could accept `status in ('draft', 'published')` and reject a
    // second statement — and it is the DECLARED side's own text, out of the author's migration,
    // where both names are the catalog's and a sidecar's. What `psqlCommand` does close is the
    // shell layer: the statement is one single-quoted word, so nothing in the predicate expands.
    fix:
      path === null || relation === null || constraint === null
        ? byHand('add the check constraint this difference names back')
        : repair(
            path,
            `alter table ${relation} add constraint ${constraint} check (${check.expression});`,
          ),
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
 * The `fix` is the pair (`repair`), not `x db migrate`: a rule cannot be altered in place, `add
 * constraint` alone is `42710` on a name already taken, and no `x db gen` diff emits either
 * statement. Same reasoning as `changedColumn`.
 *
 * `held` is the **live catalog's** and `declared` is a `.snapshot.json`'s, so every name is
 * screened and the two writers are ASKED whether they can write the pair — never a second copy of
 * their rules beside them. `identifier()` refuses a name holding a quote, a space or a backslash
 * and `addForeignKey` refuses an `on delete` rule Postgres does not have: right for DDL this
 * package SENDS, wrong for a `fix:`. `diffSchema` is documented pure and total, so a pair it
 * cannot write is a psql session and a sentence, never a throw.
 *
 * The CAUSE names the constraint the database holds, whatever it is called: a refused name is out
 * of the command, and the cause is where a reader still finds which key this is.
 */
export function changedForeignKey(
  schema: string,
  table: string,
  declared: ForeignKeyDescription,
  held: ForeignKeyDescription,
): DriftDifference {
  const rule = onDeleteRule(held.onDelete);
  const rebuilt = (): string => {
    const steps =
      'drop the foreign key this difference names and add it back with the on delete rule ' +
      'migrations declare';
    const names = [
      table,
      held.name,
      declared.name,
      declared.referencedTable,
      ...declared.columns,
      ...declared.referencedColumns,
    ];
    const path = pathTo(schema);
    if (path === null || !spellable(names)) return byHand(steps);
    try {
      return repair(path, `${dropForeignKey(table, held.name)} ${addForeignKey(table, declared)}`);
    } catch {
      return byHand(steps, 'the rule migrations declare is not one Postgres has');
    }
  };
  return {
    kind: 'changed-foreign-key',
    table,
    column: null,
    cause:
      `foreign key "${held.name}" on "${table}" (${declared.columns.join(', ')}) to ` +
      `"${declared.referencedTable}" ` +
      `${rule === null ? 'declares no on delete rule' : `is on delete ${rule}`}, not what ` +
      'migrations declare',
    fix: rebuilt(),
  };
}

const PRIMARY_KEY_BY_HAND = byHand(
  'drop the primary key this database holds, add the one migrations declare',
  `${CARRIES} or is too long, so no statement here can spell it`,
);

const keyText = (columns: readonly string[]): string =>
  columns.length === 0 ? 'no primary key' : `primary key (${columns.join(', ')})`;

/**
 * The two sides key the table differently — a different column list, a different ORDER, or a key
 * on one side only. Its own kind rather than `changed-index` on `<table>_pkey`: that finding's fix
 * is `x db migrate`, and the migration declaring this key is already in the ledger, so re-running
 * the migrator applies nothing.
 *
 * The fix is ONE command a shell runs — the pair as `psql`'s argument (`repair`).
 *
 * `held` is the constraint the DATABASE holds — the live primary index's name, which is the
 * constraint's — because that is the one a `drop constraint` has to spell. The writers are asked
 * whether they can write each statement and a refusal degrades the whole line to prose, the rule
 * `changedForeignKey` states: every name on the live side is the catalog's.
 */
export function changedPrimaryKey(
  schema: string,
  table: string,
  live: readonly string[],
  held: string | undefined,
  declared: readonly string[],
): DriftDifference {
  const statements = (): string => {
    const names = [table, ...declared, ...(held === undefined ? [] : [held])];
    const path = pathTo(schema);
    if (path === null || !spellable(names)) return PRIMARY_KEY_BY_HAND;
    try {
      const parts: string[] = [];
      if (held !== undefined) parts.push(dropPrimaryKey(table, held, false));
      if (declared.length > 0) parts.push(addPrimaryKey(table, declared));
      return repair(path, parts.join(' '));
    } catch {
      return PRIMARY_KEY_BY_HAND;
    }
  };
  return {
    kind: 'changed-primary-key',
    table,
    column: null,
    cause:
      `table "${table}" has ${keyText(live)}${held === undefined ? '' : ` as constraint "${held}"`}, ` +
      'and migrations declare ' +
      (declared.length === 0 ? 'none' : `(${declared.join(', ')})`),
    fix: statements(),
  };
}
