// Single responsibility: prove the live schema and the migration ledger agree. Drift is the
// failure an agent creates most often — it edits a table by hand, the next deploy diverges, and
// nothing complains until production. The rendered `X_DB_DRIFT` output is byte-for-byte pinned
// by the framework contract; `x verify` fails on it and `--json` carries every difference.

import { baseClient, type DbClient } from './client';
import { DbError } from './errors';
import { addForeignKey, dropForeignKey, foreignKeyTarget, onDeleteRule } from './foreign-key';
import { indexMethodOf } from './index-method';
import {
  type ForeignKeyDescription,
  findTable,
  introspect,
  type SchemaDescription,
  type TableDescription,
} from './introspect';
import { type LedgerRow, type Migration, readLedger } from './migrate';

export type DriftKind =
  | 'unexpected-column'
  | 'missing-column'
  | 'changed-column'
  | 'unexpected-table'
  | 'missing-table'
  | 'unknown-schema'
  | 'missing-index'
  | 'changed-index'
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

function unexpectedColumn(table: string, column: string): DriftDifference {
  return {
    kind: 'unexpected-column',
    table,
    column,
    // Pinned by the contract. Do not reword without changing docs/errors/X_DB_DRIFT.
    cause: `table "${table}" has column "${column}" not present in any migration`,
    fix: `x db gen "add ${column}"`,
  };
}

function missingColumn(table: string, column: string): DriftDifference {
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
function changedColumn(table: string, column: string, liveNullable: boolean): DriftDifference {
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

function unexpectedTable(table: string): DriftDifference {
  return {
    kind: 'unexpected-table',
    table,
    column: null,
    cause: `table "${table}" is not present in any migration`,
    fix: `x db gen "add ${table}"`,
  };
}

function missingTable(table: string): DriftDifference {
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
function unknownSchema(migrations: readonly Migration[]): DriftDifference {
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

function missingIndex(table: string, index: string): DriftDifference {
  return {
    kind: 'missing-index',
    table,
    column: null,
    cause: `table "${table}" is missing index "${index}" that migrations declare`,
    fix: 'x db migrate',
  };
}

function changedIndex(table: string, index: string, detail: string): DriftDifference {
  return {
    kind: 'changed-index',
    table,
    column: null,
    cause: `index "${index}" on "${table}" ${detail}, not what migrations declare`,
    fix: 'x db migrate',
  };
}

function missingForeignKey(table: string, key: ForeignKeyDescription): DriftDifference {
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
function changedForeignKey(
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
    fix:
      `${dropForeignKey(table, held.name)} ${addForeignKey(table, declared)}` +
      '   # in a new migration',
  };
}

/**
 * Indexes migrations declare, against the ones the catalog holds — by column list and by
 * uniqueness, which is what caught a composite index rebuilt with its columns the other way round
 * while `ok: true` said the schema agreed.
 *
 * Only the declared side is judged. A live index no snapshot names is **not** drift: Postgres
 * creates one for every primary key and every unique constraint, no migration declares those, and
 * an index a DBA added is a planner decision rather than a schema divergence — reporting them
 * would be eight findings against a correct database, which is how a drift check earns being
 * ignored (`appTables` exists for the same reason).
 *
 * Three of the four parts of an index are compared here; the fourth never will be. The predicate's
 * **text** is uncomparable and stays so — the catalog answers its own rewriting of the expression
 * (`(deleted_at IS NULL)`) where the snapshot holds the author's spelling (`deleted_at is null`),
 * and normalising that means shipping an expression parser to compete with the server's. `x db gen`
 * compares the text instead, where both sides are generated (`redefineIndex`).
 *
 * Its **presence** is not text but a boolean, and the direction is a closed enum on both sides, so
 * both are compared: a partial index recreated as a total one silently widens the constraint, and
 * a `desc` index rebuilt ascending by hand serves a feed's newest page off the wrong end. `asc` is
 * normalised to `null` first — `createIndex` writes `"col" asc`, which Postgres stores as
 * not-descending, so the raw values differ on every ascending index in a correct database.
 *
 * The **access method** is compared for the same reason and normalised the same way (`indexMethodOf`,
 * absent = `btree`). Without it an emitter that can write `using gin` ships a btree for a declared
 * GIN index and nothing anywhere says so — a declared-and-never-wired key, which is worse than the
 * missing capability, and the reason `using` could not land in `@ultimat3/entity` before it landed
 * here.
 */
function compareIndexes(live: TableDescription, expected: TableDescription): DriftDifference[] {
  const differences: DriftDifference[] = [];
  const present = new Map(live.indexes.map((index) => [index.name, index]));
  for (const index of expected.indexes) {
    const counterpart = present.get(index.name);
    if (counterpart === undefined) {
      differences.push(missingIndex(live.name, index.name));
      continue;
    }
    // The method first, and before the column list: a GIN index and a btree over the same column
    // are not the same index with a detail different, they are two structures the planner uses for
    // different operators — `@>` on a jsonb column is a sequential scan on the wrong one. Both
    // sides go through `indexMethodOf`, so a snapshot that predates the field and an index the
    // catalog reports as `btree` agree instead of reporting drift on a correct database.
    if (indexMethodOf(counterpart) !== indexMethodOf(index)) {
      differences.push(
        changedIndex(live.name, index.name, `is a ${indexMethodOf(counterpart)} index`),
      );
      continue;
    }
    if (counterpart.columns.join(',') !== index.columns.join(',')) {
      differences.push(
        changedIndex(live.name, index.name, `covers (${counterpart.columns.join(', ')})`),
      );
      continue;
    }
    if (counterpart.unique !== index.unique) {
      differences.push(
        changedIndex(live.name, index.name, counterpart.unique ? 'is unique' : 'is not unique'),
      );
      continue;
    }
    if ((counterpart.order ?? 'asc') !== (index.order ?? 'asc')) {
      differences.push(
        changedIndex(
          live.name,
          index.name,
          counterpart.order === 'desc' ? 'is descending' : 'is ascending',
        ),
      );
      continue;
    }
    if ((counterpart.where === null) !== (index.where === null)) {
      differences.push(
        changedIndex(
          live.name,
          index.name,
          counterpart.where === null ? 'covers every row' : 'is partial',
        ),
      );
    }
  }
  return differences;
}

/**
 * Foreign keys migrations declare, against the ones the catalog holds — matched on **where the key
 * points**, never on its name. `snapshotOf` names one the way Postgres names an inline `references`
 * clause (`posts_org_id_fkey`), a hand-written migration may have said `constraint fk_posts_org`,
 * and a constraint that points the same columns at the same table is the same constraint whatever
 * it is called; comparing the name would report drift on a database that is exactly right.
 *
 * `onDelete` **is** compared now, through `onDeleteRule`. It is not part of a key's identity — a
 * key is the same key under a different rule, which is why the difference is `changed-foreign-key`
 * rather than one `missing` — but it is a fact about the database a snapshot records truthfully
 * since `addForeignKey` spells the clause out. Both sides go through the same normalisation: the
 * catalog answers `c` where a snapshot holds `cascade`, and Postgres records `a` (`no action`) on
 * every key that declared nothing.
 *
 * Only the declared side is judged, for the reason `compareIndexes` gives.
 */
function compareForeignKeys(live: TableDescription, expected: TableDescription): DriftDifference[] {
  // The same identity `x db gen` diffs on (`foreign-key.ts`): a generator and a detector that
  // disagreed about whether two keys are the same key is drift on a correct database.
  const present = new Map(live.foreignKeys.map((key) => [foreignKeyTarget(key), key] as const));
  const differences: DriftDifference[] = [];
  for (const key of expected.foreignKeys) {
    const counterpart = present.get(foreignKeyTarget(key));
    if (counterpart === undefined) {
      differences.push(missingForeignKey(live.name, key));
      continue;
    }
    if (onDeleteRule(counterpart.onDelete) !== onDeleteRule(key.onDelete)) {
      differences.push(changedForeignKey(live.name, key, counterpart));
    }
  }
  return differences;
}

/**
 * A primary key column is `NOT NULL` in the catalog whether or not anything declared it — Postgres
 * adds the constraint with the key. Both sides are therefore read through the union of the two
 * primary keys, or a table whose snapshot spells its key column nullable reports a difference
 * against a database that is exactly right and cannot be anything else. The union, not one side:
 * a key present on only one of them is a difference the *key* comparison owns, and reporting it
 * again as a nullability change would be one fault with two findings.
 */
function keyColumnsOf(live: TableDescription, expected: TableDescription): ReadonlySet<string> {
  return new Set([...live.primaryKey, ...expected.primaryKey]);
}

function compareTable(live: TableDescription, expected: TableDescription): DriftDifference[] {
  const differences: DriftDifference[] = [];
  const expectedColumns = new Map(expected.columns.map((column) => [column.name, column]));
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]));
  const keyColumns = keyColumnsOf(live, expected);
  for (const column of live.columns) {
    if (expectedColumns.has(column.name)) continue;
    differences.push(unexpectedColumn(live.name, column.name));
  }
  for (const column of expected.columns) {
    const counterpart = liveColumns.get(column.name);
    if (counterpart === undefined) {
      differences.push(missingColumn(live.name, column.name));
      continue;
    }
    // Nullability, not the type: the catalog and a snapshot spell types differently often enough
    // that comparing them here would report drift on a correct database, and `x db gen`'s
    // `retypeColumn` already owns that question where both sides are generated.
    if (keyColumns.has(column.name)) continue;
    if (column.nullable !== counterpart.nullable) {
      differences.push(changedColumn(live.name, column.name, counterpart.nullable));
    }
  }
  differences.push(...compareIndexes(live, expected));
  differences.push(...compareForeignKeys(live, expected));
  return differences;
}

/** Pure and total: the same inputs always produce the same ordered report. */
export function diffSchema(live: SchemaDescription, expected: SchemaDescription): DriftReport {
  const differences: DriftDifference[] = [];
  for (const table of live.tables) {
    const counterpart = findTable(expected, table.name);
    if (counterpart === undefined) differences.push(unexpectedTable(table.name));
    else differences.push(...compareTable(table, counterpart));
  }
  for (const table of expected.tables) {
    if (findTable(live, table.name) === undefined) differences.push(missingTable(table.name));
  }
  differences.sort((a, b) => {
    if (a.table !== b.table) return a.table < b.table ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return (a.column ?? '') < (b.column ?? '') ? -1 : 1;
  });
  return { ok: differences.length === 0, differences };
}

export function driftError(difference: DriftDifference): DbError {
  return new DbError({
    code: 'X_DB_DRIFT',
    cause: difference.cause,
    fix: difference.fix,
    meta: { kind: difference.kind, table: difference.table, column: difference.column },
  });
}

/**
 * Throws the first difference. The one caller is the release phase — `runRole` in `@ultimat3/cli`
 * under `ROLE=migrate`, where the exit code is the only channel a container has. `x db migrate`
 * and `x db reset` hold the same report and render every difference as a finding instead
 * (`driftFindings`), and `x verify`'s `drift` step is the *source* detector (`checkSourceDrift`),
 * which never reaches this function. There is no `x db drift` command.
 */
export function assertNoDrift(report: DriftReport): void {
  const first = report.differences[0];
  if (first !== undefined) throw driftError(first);
}

/**
 * The schema the migration files themselves declare, ledger or no ledger, or `undefined` when
 * they do not declare one. Each generated migration carries the snapshot it leaves behind, so the
 * **newest** migration's snapshot is the claim — no SQL is re-parsed.
 *
 * The newest one, never the newest one that happens to have a snapshot: a later migration without
 * a sidecar has changed the schema in ways nothing wrote down, so an earlier snapshot is not a
 * partial answer but a wrong one. `0001` records `posts`, `0002` adds a column by hand, and
 * reaching back to `0001` reports the column the database correctly holds as `unexpected-column`
 * — drift against a schema that is exactly right, with `x db gen "add …"` as the fix for a
 * migration that already exists.
 *
 * An empty list has nothing to declare and is `{ tables: [] }`, which is a real answer: an app
 * with no migration yet owes the database no table.
 *
 * This is what `x db gen` diffs the app's entities against, and why generating a migration needs
 * no database: the previous migration already wrote down what it left behind.
 */
export function declaredSchema(migrations: readonly Migration[]): SchemaDescription | undefined {
  const ordered = [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1));
  const newest = ordered[ordered.length - 1];
  if (newest === undefined) return { tables: [] };
  return newest.snapshot;
}

/**
 * The schema migrations claim to have *applied* — `declaredSchema` over the ledger's own subset,
 * never a second reading of the same snapshots. Generation asks "what have we written down" and
 * drift asks "what does this database owe us"; two answers, one implementation, so a snapshot can
 * never mean one thing to `x db gen` and another to `x verify`.
 */
export function expectedSchema(
  migrations: readonly Migration[],
  ledger: readonly LedgerRow[],
): SchemaDescription | undefined {
  const applied = new Set(ledger.map((row) => row.id));
  return declaredSchema(migrations.filter((migration) => applied.has(migration.id)));
}

/**
 * Framework bookkeeping is not app schema. The ledger, the job queue's tables, the outbox and
 * every `@ultimat3/auth` table are created by `create table if not exists` at boot — no migration
 * declares them and no snapshot carries them, so each one reads as `unexpected-table` against a
 * schema that is in fact correct. The `x_` prefix is the convention every framework table already
 * follows, so a table a future package adds needs no second list here.
 *
 * `introspect()` keeps its own narrower default (`x_migrations` alone) on purpose: the admin
 * dashboard's schema view and the MCP `schema.describe` tool legitimately show `x_users`. Only
 * drift wants the whole namespace gone, so only drift declares it.
 */
export const FRAMEWORK_TABLE_PREFIX = 'x_';

/** The live schema minus framework bookkeeping — what a migration snapshot can be compared to. */
export function appTables(live: SchemaDescription): SchemaDescription {
  return { tables: live.tables.filter((t) => !t.name.startsWith(FRAMEWORK_TABLE_PREFIX)) };
}

export interface DriftOptions {
  readonly migrations: readonly Migration[];
  readonly client?: DbClient | undefined;
  readonly schema?: string | undefined;
}

/**
 * **The post-migrate verification**: the live database against the ledger it just wrote. This is
 * the one drift question that needs a database, so it is asked where one is open — `runMigrations`
 * in `@ultimat3/cli`, which is `x db migrate`, `x db reset` and `ROLE=migrate` alike.
 *
 * The other drift question — "the entity source was edited and no migration recorded it" — needs
 * no database and is `x verify`'s `drift` step (`checkSourceDrift`, `@ultimat3/cli`). Two
 * conditions, two detectors, one `X_DB_DRIFT`; a check that opened a database in CI could not run
 * at all, and one that read files could not see a column added by hand.
 */
export async function checkDrift(options: DriftOptions): Promise<DriftReport> {
  const client = options.client ?? baseClient();
  const ledger = await readLedger(client);
  const expected = expectedSchema(options.migrations, ledger);
  // Unknowable, not clean: the newest applied migration wrote no snapshot, so there is nothing to
  // compare the catalog to. Reported as its own difference rather than answered with a stale
  // snapshot's verdict, because a wrong `ok: false` sends an author to fix a schema that is right
  // and a wrong `ok: true` is the failure this check exists to prevent.
  if (expected === undefined)
    return { ok: false, differences: [unknownSchema(options.migrations)] };
  const live = await introspect({
    client,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  return diffSchema(appTables(live), expected);
}
