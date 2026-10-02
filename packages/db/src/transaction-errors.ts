// Single responsibility: the two refusals a transaction's END can raise — the server rolled it back
// while the body carried on, and the answer to COMMIT never arrived. Split from `errors.ts` at the
// file-size rule; both are thrown by `transaction.ts`, the first by the two statement funnels too.

import { renderThrowable } from '@ultimat3/core';
import { DbError } from './errors';
import { sqlState } from './sqlstate';

const ABORTED_FIX =
  'await withTransaction(() => fallible()).catch(fallback)   # a nested scope is a SAVEPOINT, so ' +
  'only it rolls back — or rethrow the statement error instead of catching it';

/**
 * Postgres aborts the WHOLE transaction on any statement error and answers the `COMMIT` that
 * follows with the tag `ROLLBACK` and no error, so a body that caught the failure and returned was
 * reported committed with nothing stored. `first` is the statement the body threw away — rendered
 * into the cause, deliberately NOT chained as `sourceError`: `sqlState()` unwraps that chain, and a
 * caller asking "was this a unique violation" would be answered yes by an error that means the
 * whole unit of work is gone.
 */
export const transactionAborted = (first?: unknown): DbError => {
  const state = sqlState(first);
  return new DbError({
    code: 'X_DB_TRANSACTION_ABORTED',
    cause:
      first === undefined
        ? 'COMMIT was answered with ROLLBACK: a statement failed earlier in this transaction, its error was caught, and the server had already rolled the whole unit of work back'
        : `a statement failed inside the transaction and the error was caught rather than rethrown, so the server rolled the whole unit of work back: ${renderThrowable(first)}`,
    fix: ABORTED_FIX,
    ...(state === undefined ? {} : { meta: { sqlState: state } }),
  });
};

/**
 * A nested scope gave up waiting for the sibling holding the turn. Names both: the scope that
 * waited is identified by its parent (it never opened, so it has no savepoint of its own), and the
 * holder by the savepoint it is inside. Terminal: the usual cause is a body awaiting a sibling
 * queued behind it, and the same call made again waits for the same cycle.
 */
export const siblingScopeTimeout = (
  parent: string,
  holder: string | undefined,
  waitedMs: number,
): DbError =>
  new DbError({
    code: 'X_DB_SIBLING_SCOPE_TIMEOUT',
    cause: `a nested scope under ${parent} waited ${waitedMs}ms for its sibling ${holder ?? 'scope'} to finish and never got a turn — sibling scopes run one after the other, so a body that awaits a sibling started after it waits for itself`,
    fix: 'await withTransaction(first); await withTransaction(second)   # one after the other, never a nested body awaiting a sibling — or raise the wait: withTransaction(fn, { siblingWaitMs: 120000 })',
    meta: { parent, waitedMs, ...(holder === undefined ? {} : { holder }) },
  });

/**
 * `COMMIT` was sent and rejected with no SQLSTATE — the socket went before the answer did. The
 * transaction is durable or it is not, and nothing on this side can say which, so neither list
 * runs: an `onRollback` undo would revert state the database may have kept, and an `onCommit`
 * effect would announce rows it may not have.
 */
export const commitUnknown = (sourceError: unknown): DbError =>
  new DbError({
    code: 'X_DB_COMMIT_UNKNOWN',
    cause: `the connection failed while COMMIT was in flight, so the transaction is either durable or rolled back and this process cannot tell which; neither onCommit effects nor onRollback undos ran: ${renderThrowable(sourceError)}`,
    fix: 'psql "$DATABASE_URL" -c "<select a row this transaction wrote>"   # present: it committed, do not re-run; absent: re-run the unit of work',
    sourceError,
  });
