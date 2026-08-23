// The database layer's stable error codes. Every factory produces the exact command that
// fixes the situation — `X_DB_DRIFT` is the flagship and its rendering is byte-for-byte
// pinned by the framework contract, so change its strings only with the contract.

import { registerErrorCodes, renderThrowable, stringField, UltimateError } from '@ultimat3/core';
import { DESTRUCTIVE_CAUSE, DESTRUCTIVE_MARKER, type DestructiveStatement } from './destructive';
import { type DbSqlStateCode, sqlState, sqlStateCode } from './sqlstate';

/**
 * Codes this package declares and owns. `X_DB_DRIFT` is db's: it is a statement about migrations
 * against a schema, and `@ultimat3/entity` — which imports db — only throws it.
 */
export const DB_OWNED_ERROR_CODES = [
  'X_DB_UNAVAILABLE',
  'X_DB_UNIQUE_VIOLATION',
  'X_DB_FOREIGN_KEY_VIOLATION',
  'X_DB_SERIALIZATION_FAILURE',
  'X_DB_STATEMENT_TIMEOUT',
  'X_DB_LOCK_TIMEOUT',
  'X_DB_POOL_EXHAUSTED',
  'X_DB_DRIFT',
  'X_MIGRATION_CONFLICT',
  'X_MIGRATION_IRREVERSIBLE',
  'X_MIGRATION_DESTRUCTIVE',
  'X_MIGRATION_SNAPSHOT_MISSING',
  'X_MIGRATE_CONCURRENT',
  'X_SQL_UNSAFE',
  'X_BRANCH_EXISTS',
] as const;

/**
 * `@ultimat3/core`'s. Never titled here, never registered here. `X_ENV_MISSING` is core's word for
 * "a variable this process was given is missing or invalid", and `DATABASE_POOL_MAX` is one — a
 * db-local code for it would be a second answer to a question core already answers.
 *
 * `X_INVARIANT` is core's own "the generic code, for checks that have no dedicated code yet"
 * (`assert()` in `core/src/assert.ts`), borrowed the same way `@ultimat3/money`'s `roundRatio`
 * borrows it: an argument a caller built wrong is not a fact about the ledger or the schema, so
 * none of the `X_MIGRATION_*` codes above describes one.
 */
export const DB_BORROWED_ERROR_CODES = [
  'X_NOT_IMPLEMENTED',
  'X_ENV_MISSING',
  'X_INVARIANT',
] as const;

/** Every code db can throw: the ones it owns plus the ones it borrows. */
export const DB_ERROR_CODES = [...DB_OWNED_ERROR_CODES, ...DB_BORROWED_ERROR_CODES] as const;

export type DbOwnedErrorCode = (typeof DB_OWNED_ERROR_CODES)[number];
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export const DB_ERROR_TITLES: Readonly<Record<DbOwnedErrorCode, string>> = {
  X_DB_UNAVAILABLE: 'cannot reach the database',
  X_DB_UNIQUE_VIOLATION: 'a unique constraint rejected the row',
  X_DB_FOREIGN_KEY_VIOLATION: 'a foreign key constraint rejected the row',
  X_DB_SERIALIZATION_FAILURE: 'the transaction lost a serialization race',
  X_DB_STATEMENT_TIMEOUT: 'the statement ran past its statement_timeout',
  X_DB_LOCK_TIMEOUT: 'the statement waited past its lock_timeout',
  X_DB_POOL_EXHAUSTED: 'no connection was available',
  X_DB_DRIFT: 'schema differs from migrations',
  X_MIGRATION_CONFLICT: 'the migration ledger disagrees with this build',
  X_MIGRATE_CONCURRENT: 'another migrator holds the migration lock',
  X_MIGRATION_IRREVERSIBLE: 'this migration cannot be reversed without data loss',
  X_MIGRATION_DESTRUCTIVE: 'this migration destroys data and does not say so',
  X_MIGRATION_SNAPSHOT_MISSING: 'the newest migration records no schema snapshot',
  X_SQL_UNSAFE: 'SQL was built by string interpolation',
  X_BRANCH_EXISTS: 'that branch database already exists',
};

// Registered unconditionally, in one call, so a second package claiming one of db's codes fails
// loudly as X_ERROR_CODE_DUPLICATE at import instead of silently losing to whoever loaded first.
registerErrorCodes(
  Object.fromEntries(Object.entries(DB_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export interface DbErrorInit {
  readonly code: DbErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  readonly sourceError?: unknown;
}

export class DbError extends UltimateError {
  override readonly name = 'DbError';
  /**
   * `code` is deliberately NOT re-declared here. `declare` cannot combine with `override`,
   * and a plain re-declaration would shadow the property `UltimateError`'s constructor
   * already assigned — under `useDefineForClassFields` that resets it to `undefined` at
   * runtime. Callers get the narrow type from `DbErrorInit` at the construction site,
   * which is where it matters.
   */

  constructor(init: DbErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      meta: init.meta,
      sourceError: init.sourceError,
    });
  }
}

export const dbUnavailable = (detail: string, sourceError?: unknown): DbError =>
  new DbError({
    code: 'X_DB_UNAVAILABLE',
    cause: detail,
    fix: 'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    sourceError,
  });

/**
 * One `fix:` per classified SQLSTATE, written once. Every one names a command that exists or an
 * edit the reader can make — a `23505` telling an operator the database is unreachable is the
 * failure this table exists to end.
 *
 * `X_DB_UNIQUE_VIOLATION`'s and `X_DB_FOREIGN_KEY_VIOLATION`'s take the constraint the server
 * named, so the fix points at the one index or key that refused the row rather than at the idea
 * of one; `driverError` substitutes the placeholder when the driver reported none.
 */
const SQLSTATE_FIXES = Object.freeze<Record<DbSqlStateCode, string>>({
  X_DB_UNIQUE_VIOLATION:
    'upsertAll(rows, { onConflict: [...] }) over the columns {constraint} covers — ' +
    'or catch X_DB_UNIQUE_VIOLATION and answer 409, which is what a raced signup is',
  X_DB_FOREIGN_KEY_VIOLATION:
    'insert the row {constraint} points at first, in the same withTransaction(...) — ' +
    'or drop the write, because the parent it names is gone',
  X_DB_SERIALIZATION_FAILURE:
    'withTransaction(fn, { retry: 3 })   # fn re-runs from the top, so it must be idempotent',
  X_DB_STATEMENT_TIMEOUT:
    'add the index this statement needs to the entity (indexes: [...]), then: x db gen "add index"',
  X_DB_LOCK_TIMEOUT:
    `psql "$DATABASE_URL" -c "select pid, state, query from pg_stat_activity where state <> 'idle'"` +
    '   # end the blocker, then re-run the statement',
  X_DB_POOL_EXHAUSTED:
    'set DATABASE_POOL_MAX below max_connections / replicas (per-role default: POOL_PROFILES), ' +
    'or cut the replica count',
});

/** Substituted into a fix when the driver named no constraint — `{constraint}`'s stand-in. */
const UNNAMED_CONSTRAINT = 'the constraint named in cause';

/**
 * Every driver failure, typed by what the server actually said. The SQLSTATE has always been on
 * the error — `isLedgerMissing` proved the read worked — and nothing exposed it, so a `23505`
 * unique violation, a `40001` serialization failure and a `57014` timeout all reached the caller
 * as `X_DB_UNAVAILABLE`, whose fix is "set DATABASE_URL to a reachable Postgres url". Two clicks
 * racing a signup paged on-call for an outage that never happened.
 *
 * `X_DB_UNAVAILABLE` stays the answer for everything the table does not classify, including every
 * failure that never reached a server: that code's meaning is unchanged, its fix is finally only
 * given where it is true, and a new SQLSTATE arrives as a new row here rather than as a new
 * `catch` at a call site.
 */
export const driverError = (detail: string, sourceError: unknown): DbError => {
  const code = sqlStateCode(sourceError);
  if (code === undefined) return dbUnavailable(detail, sourceError);
  const state = sqlState(sourceError);
  const constraint = stringField(sourceError, 'constraint');
  return new DbError({
    code,
    cause: `${detail}: ${renderThrowable(sourceError)} [SQLSTATE ${state ?? '?????'}]`,
    // A FUNCTION as the replacement, never the string: `String.replace` expands `$&`, `` $` ``,
    // `$'` and `$$` inside a replacement literal, and a constraint name is the server's, not
    // ours — `$` is legal in a Postgres identifier, so `posts_$&_key` would splice the matched
    // `{constraint}` back into the fix line an author is meant to paste.
    fix: SQLSTATE_FIXES[code].replace('{constraint}', () => constraint ?? UNNAMED_CONSTRAINT),
    meta: {
      sqlState: state,
      ...(constraint === undefined ? {} : { constraint }),
    },
    sourceError,
  });
};

/**
 * The pool answered nothing inside `acquireTimeoutMs`. Distinct from the server's own `53300` and
 * deliberately the same code: to a caller both mean "there was no connection for this unit of
 * work", and a second code would split one runbook in two. Queueing forever instead turns
 * exhaustion into a hang — `/readyz` joins the queue, the kubelet kills the pod, and the next pod
 * inherits the same saturated database.
 */
export const poolAcquireTimeout = (waitedMs: number, max: number): DbError =>
  new DbError({
    code: 'X_DB_POOL_EXHAUSTED',
    cause: `no connection came free within ${waitedMs}ms; every one of the pool's ${max} is in use`,
    fix: SQLSTATE_FIXES.X_DB_POOL_EXHAUSTED,
    meta: { waitedMs, max },
  });

/**
 * `DATABASE_POOL_MAX` is the one pool knob an operator can reach without a rebuild, so a typo in it
 * must refuse at boot rather than silently fall back to the role default — a fleet that ignored the
 * value it was given is the failure the variable exists to prevent.
 */
export const poolMaxInvalid = (received: string): DbError =>
  new DbError({
    code: 'X_ENV_MISSING',
    cause: `DATABASE_POOL_MAX is ${JSON.stringify(received)}, which is not a positive integer`,
    fix: 'DATABASE_POOL_MAX=20   # a whole number of connections per process, or unset it',
    meta: { received },
  });

/**
 * `withTransaction(fn, { retry: n })` re-ran `fn` from the top `n` times and lost the race every
 * time. The last driver error is kept as `sourceError` so the SQLSTATE survives, and the cause
 * names the count because "it failed again" and "it failed 4 times in a row" are different
 * problems: the second one is contention the application has to reduce, not a retry to add.
 */
export const serializationExhausted = (attempts: number, sourceError: unknown): DbError =>
  new DbError({
    code: 'X_DB_SERIALIZATION_FAILURE',
    cause:
      `the transaction lost its serialization race on all ${attempts} attempts: ` +
      renderThrowable(sourceError),
    fix:
      'raise the retry budget — withTransaction(fn, { retry: 8 }) — or cut the contention: ' +
      "narrow what the transaction reads, or drop to isolation: 'repeatable read'",
    meta: { attempts },
    sourceError,
  });

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

/** The contract's pinned wording. Mirror of `@ultimat3/entity`'s `dbDrift()` — keep in sync. */
export const dbDrift = (tableName: string, columnName: string): DbError =>
  new DbError({
    code: 'X_DB_DRIFT',
    cause: `table "${tableName}" has column "${columnName}" not present in any migration`,
    fix: `x db gen "add ${columnName}"`,
    meta: { table: tableName, column: columnName },
  });

export const migrationConflict = (cause: string, fix: string): DbError =>
  new DbError({ code: 'X_MIGRATION_CONFLICT', cause, fix });

export const migrationIrreversible = (cause: string, fix: string): DbError =>
  new DbError({ code: 'X_MIGRATION_IRREVERSIBLE', cause, fix });

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

export const sqlUnsafe = (received: string, position: number): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause:
      `interpolation #${position} in a sql\`\` template is ${received}, ` +
      'which cannot be bound as a parameter',
    fix: 'pass a scalar (it becomes $n), a nested sql`` fragment, or wrap audited SQL in raw()',
    meta: { position, received },
  });

export const identifierUnsafe = (name: string): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `${JSON.stringify(name)} is not usable as a Postgres identifier`,
    fix: 'pass a plain table/column name — identifiers cannot be bound as parameters',
    meta: { name },
  });

/**
 * More than one command in a text that gets **spliced** — into `DECLARE … CURSOR FOR`, or sent
 * whole on a driver that degrades to the simple protocol. `X_SQL_UNSAFE` rather than a validation
 * code for the same reason `branchNameInvalid` uses it: a second command riding an interpolated
 * statement is an injection, not a typo. Only the first is bounded by the guards `readOnlyQuery`
 * just installed, so `SET LOCAL statement_timeout` was undone by the second while `guards` still
 * reported `timeout:5000ms` — a defeated layer reported as an engaged one.
 */
export const multipleStatements = (statement: string, count: number): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `a read-only query must be ONE statement; this text holds ${count}: ${statement}`,
    fix: 'await readOnlyQuery(first); await readOnlyQuery(second)   # one statement per call',
    meta: { count },
  });

export const branchExists = (branch: string): DbError =>
  new DbError({
    code: 'X_BRANCH_EXISTS',
    cause: `database "${branch}" already exists`,
    fix: `x db branch drop ${branch}   # then re-create, or pick another name`,
    meta: { branch },
  });

/**
 * An unvalidated branch name is spliced into `CREATE DATABASE "<name>"`, so a bad name is an
 * injection vector, not a typo — hence `X_SQL_UNSAFE` rather than a validation code.
 */
export const branchNameInvalid = (branch: string): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `branch name "${branch}" is not [a-z0-9_-]+`,
    fix: 'x db branch create <name>   # lowercase letters, digits, underscore and dash only',
    meta: { branch },
  });

export const dbNotImplemented = (feature: string, fix: string): DbError =>
  new DbError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is not implemented by this driver`,
    fix,
  });
