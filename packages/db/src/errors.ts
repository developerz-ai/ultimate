// The database layer's stable error codes. Every factory produces the exact command that
// fixes the situation — `X_DB_DRIFT` is the flagship and its rendering is byte-for-byte
// pinned by the framework contract, so change its strings only with the contract.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';
import { DESTRUCTIVE_CAUSE, DESTRUCTIVE_MARKER, type DestructiveStatement } from './destructive';

/**
 * Codes this package declares and owns. `X_DB_DRIFT` is db's: it is a statement about migrations
 * against a schema, and `@ultimat3/entity` — which imports db — only throws it.
 */
export const DB_OWNED_ERROR_CODES = [
  'X_DB_UNAVAILABLE',
  'X_DB_DRIFT',
  'X_MIGRATION_CONFLICT',
  'X_MIGRATION_IRREVERSIBLE',
  'X_MIGRATION_DESTRUCTIVE',
  'X_MIGRATION_SNAPSHOT_MISSING',
  'X_SQL_UNSAFE',
  'X_BRANCH_EXISTS',
  'X_READONLY_VIOLATION',
] as const;

/** `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. Never titled here, never registered here. */
export const DB_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

/** Every code db can throw: the ones it owns plus the ones it borrows. */
export const DB_ERROR_CODES = [...DB_OWNED_ERROR_CODES, ...DB_BORROWED_ERROR_CODES] as const;

export type DbOwnedErrorCode = (typeof DB_OWNED_ERROR_CODES)[number];
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export const DB_ERROR_TITLES: Readonly<Record<DbOwnedErrorCode, string>> = {
  X_DB_UNAVAILABLE: 'cannot reach the database',
  X_DB_DRIFT: 'schema differs from migrations',
  X_MIGRATION_CONFLICT: 'the migration ledger disagrees with this build',
  X_MIGRATION_IRREVERSIBLE: 'this migration cannot be reversed without data loss',
  X_MIGRATION_DESTRUCTIVE: 'this migration destroys data and does not say so',
  X_MIGRATION_SNAPSHOT_MISSING: 'the newest migration records no schema snapshot',
  X_SQL_UNSAFE: 'SQL was built by string interpolation',
  X_BRANCH_EXISTS: 'that branch database already exists',
  X_READONLY_VIOLATION: 'a mutating statement reached a read-only client',
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
      docs: `https://ultimate.dev/errors/${init.code}`,
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
 * The sidecar every generated migration writes is what the *next* generation diffs against, so a
 * newest migration without one leaves nothing to diff. Refused rather than defaulted to the empty
 * schema, which would generate `create table` for every table the database already holds.
 */
export const migrationSnapshotMissing = (id: string, file: string): DbError =>
  new DbError({
    code: 'X_MIGRATION_SNAPSHOT_MISSING',
    cause: `migration "${id}" records no schema snapshot, so there is nothing to diff against`,
    fix: `restore ${file} from version control, or delete "${id}" and regenerate it`,
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
    fix: 'send one statement per readOnlyQuery() call — split the text on its top-level ";" and run each separately',
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

export const readonlyViolation = (statement: string, keyword: string): DbError =>
  new DbError({
    code: 'X_READONLY_VIOLATION',
    cause: `a read-only client received a ${keyword.toUpperCase()} statement: ${statement}`,
    fix: 'use db() instead of readOnly(db()), or rewrite the statement as a SELECT',
    meta: { keyword },
  });

export const dbNotImplemented = (feature: string, fix: string): DbError =>
  new DbError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is not implemented by this driver`,
    fix,
  });
