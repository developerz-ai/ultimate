// Single responsibility: the refusals a MIGRATION earns — the lock it could not take, a ledger that
// disagrees with this build, a plan that cannot be reversed, a plan that destroys rows without
// saying so, a snapshot that was never written, and a view standing in a retype's way. Split out of
// `errors.ts` only because that file reached the 500-line ceiling, exactly as `invariant-errors.ts`
// was: every code below is still declared, titled and registered there, and `DbError` is still the
// one class. One direction only — nothing here is imported back.

import { DESTRUCTIVE_CAUSE, DESTRUCTIVE_MARKER, type DestructiveStatement } from './destructive';
import { DbError } from './errors';

/**
 * The migration advisory lock was still held when the wait ran out. `pg_advisory_lock` blocks with
 * no timeout, so a migrator wedged on a partition — or OOM-killed with its backend still alive —
 * left `helm upgrade --wait` sitting inside one statement, printing nothing, with the job never
 * failing so `backoffLimit` never fired. A bounded `pg_try_advisory_lock` poll turns that into an
 * exit code.
 */
export const migrateConcurrent = (lockKey: number, waitedMs: number): DbError =>
  new DbError({
    code: 'X_MIGRATE_CONCURRENT',
    cause:
      `another session still holds pg_advisory_lock(${lockKey}) after waiting ${waitedMs}ms, ` +
      'so this migrator refused rather than block a deploy forever',
    fix:
      'psql "$DATABASE_URL" -c "select pid, application_name, state from pg_stat_activity ' +
      "join pg_locks using (pid) where locktype = 'advisory'\"" +
      '   # pg_terminate_backend(pid) the wedged migrator, then: x db migrate',
    meta: { lockKey, waitedMs },
  });

export const migrationConflict = (cause: string, fix: string): DbError =>
  new DbError({ code: 'X_MIGRATION_CONFLICT', cause, fix });

export const migrationIrreversible = (cause: string, fix: string): DbError =>
  new DbError({ code: 'X_MIGRATION_IRREVERSIBLE', cause, fix });

/**
 * A view standing in the way of a retype, refused one statement before Postgres would have.
 *
 * `restore` is the caller's, the way `migrationIrreversible`'s `fix:` is: it is DDL built out of
 * live catalog values through `identifier()`, and this file may not import `sql.ts` — that module
 * imports `identifierUnsafe` from here, and an import cycle around the module whose evaluation
 * REGISTERS every code is not a cycle worth having for one quoted name.
 */
export const migrationViewDepends = (
  view: string,
  table: string,
  column: string,
  restore: string,
): DbError =>
  new DbError({
    code: 'X_MIGRATION_VIEW_DEPENDS',
    cause:
      `view "${view}" is compiled against "${table}"."${column}", which this migration retypes; ` +
      'Postgres answers 0A000 and rolls the whole migration back',
    fix: restore,
    meta: { view, table, column },
  });

/**
 * A rollback step count this build cannot honour. `steps` reaches `Array.prototype.slice`, where a
 * negative count counts from the END: `steps: -1` selected every applied migration except the
 * newest and reversed four of five, which is the one class of mistake a rollback cannot undo.
 * Refused rather than coerced, exactly as `DATABASE_POOL_MAX` is — a number silently reinterpreted
 * as a different one is the failure a validated argument exists to prevent.
 */
export const rollbackStepsInvalid = (received: number): DbError =>
  new DbError({
    code: 'X_INVARIANT',
    cause: `rollback was asked to reverse ${String(received)} migrations, which is not a positive integer`,
    fix: 'rollback({ migrations, steps: 1 })   # a whole number of migrations, newest first',
    meta: { steps: received },
  });

/**
 * `packages/db/migrations/0000_initial.snapshot.json` → `packages/db/migrations/0000_initial.*` —
 * every file that one migration owns, as one `rm` argument. Derived from the path the caller passed
 * rather than rebuilt from a directory this package does not know: `db` is tier 1 and where an app
 * keeps its migrations is `@ultimat3/cli`'s answer, not this one's.
 */
const snapshotSiblings = (file: string): string => file.replace(/\.snapshot\.json$/, '.*');

/**
 * `20260817120000_add_posts` → `add_posts`, the argument `x db gen` takes. The name is free text
 * and only ever labels a *new* id, so an id carrying no stamp answers with itself rather than with
 * the empty string — a `fix:` ending in `x db gen ""` is a command that cannot be run.
 */
const migrationNameOf = (id: string): string => id.replace(/^\d+_/, '') || id;

/**
 * The sidecar every generated migration writes is what the *next* generation diffs against, so a
 * newest migration without one leaves nothing to diff. Refused rather than defaulted to the empty
 * schema, which would generate `create table` for every table the database already holds.
 */
export const migrationSnapshotMissing = (id: string, file: string): DbError =>
  new DbError({
    code: 'X_MIGRATION_SNAPSHOT_MISSING',
    cause: `migration "${id}" records no schema snapshot (${file}), so there is nothing to diff against`,
    // Two remedies, both commands, in the order they are safe to try. "restore from version
    // control" alone was neither: on a scaffolded app the sidecar was never written, so there is
    // nothing to restore — and the drift this refusal answers named `x db gen` as *its* fix, so
    // the two errors pointed at each other and an app's first migration had no way out.
    // `x db gen` is named only *after* the files it would trip over are gone.
    fix:
      `git checkout -- ${file}   # or, if it was never written: ` +
      `rm ${snapshotSiblings(file)} && x db gen "${migrationNameOf(id)}"`,
    meta: { id, file },
  });

/**
 * One error per file, never one per statement: the marker declares the whole migration, so a
 * second finding would repeat an instruction the first already gave. `file` is app-relative and
 * arrives from the caller — `db` is tier 1 and does not know where an app keeps its migrations.
 *
 * Irreversible and destructive are two questions. `X_MIGRATION_IRREVERSIBLE` refuses to *generate*
 * a plan whose `down` cannot restore the rows; this one refuses to *ship* a plan whose `up`
 * destroys them without saying so — a retype is reversible in DDL and still rewrites every row.
 */
export const migrationDestructive = (
  file: string,
  first: DestructiveStatement,
  more = 0,
): DbError =>
  new DbError({
    code: 'X_MIGRATION_DESTRUCTIVE',
    cause:
      `${file} ${DESTRUCTIVE_CAUSE[first.kind]} and does not declare it` +
      `${more === 0 ? '' : ` (and ${more} more destructive)`}: ${first.statement}`,
    fix: `add the line "${DESTRUCTIVE_MARKER}" to ${file}, or regenerate it: x db gen "<name>" --allow-destructive`,
    meta: { file, kind: first.kind, statements: more + 1 },
  });
