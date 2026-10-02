// Single responsibility: the server's answer to `COMMIT`, read. Postgres answers a COMMIT on an
// aborted transaction with the command tag `ROLLBACK` and NO error, so a driver that reports only
// rejections calls a rolled-back unit of work committed. Both funnels (`statement-funnel.ts`,
// `pglite.ts`) ask here, so every COMMIT in the process is covered and not only `withTransaction`'s.

import { stringField } from '@ultimat3/core';
import { transactionAborted } from './transaction-errors';

/** `COMMIT` and its alias `END`, as the first word. Only consulted once the tag already disagrees. */
const COMMIT_STATEMENT = /^\s*(?:commit|end)\b/i;

/**
 * Throws `X_DB_TRANSACTION_ABORTED` when `text` asked for a commit and the tag says `ROLLBACK`.
 * The tag is read first: one property read per statement on the path every statement takes, and
 * the regular expression runs only for a statement that really was answered `ROLLBACK`. Both
 * drivers carry the tag on `command` — measured on Bun.SQL against Postgres 17 and on PGlite.
 */
export function refuseRolledBackCommit(text: string, result: unknown): void {
  if (stringField(result, 'command') !== 'ROLLBACK') return;
  if (COMMIT_STATEMENT.test(text)) throw transactionAborted();
}
