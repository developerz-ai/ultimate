// The Postgres half of `Transactor`: one real transaction per `run`, the `Tx` a token. Split from
// `pg-driver.ts`, which is the repositories — the two meet only through `db()`, never an import.

import { type TransactionOptions, withTransaction } from '@ultimat3/db';
import type { Transactor } from './repo';

/**
 * A real Postgres transaction behind the same `Transactor` the in-memory one implements. The
 * `Tx` handed to the callback is a token: repositories find the transaction through `db()`, so
 * nothing has to thread a connection through the call stack.
 */
export const postgresTransactor = (options: TransactionOptions = {}): Transactor => ({
  run: (work) =>
    withTransaction(
      (tx) =>
        work({
          id: tx.id,
          onRollback: (undo: () => void) => tx.onRollback(undo),
          onCommit: (effect: () => void) => tx.onCommit(effect),
        }),
      options,
    ),
});
