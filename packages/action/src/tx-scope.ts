/**
 * The open database transaction, as this package needs it — **the only** file here that imports
 * `@ultimat3/db` (`tx-scope.test.ts` holds that). When is a write durable (`openCommitScope`, the
 * cache bust), and is a transaction really OPEN, on which client (`liveTransaction`, idempotency).
 */

// Type-only: `idempotency-postgres.ts` imports this module, and a runtime edge would be a cycle.
import type { PgExecutor } from '@ultimat3/core';
import { currentTx, liveTxConnection } from '@ultimat3/db';

/** The half of a transaction a deferred effect needs. `@ultimat3/db`'s `DbTx` satisfies it. */
export interface CommitScope {
  /** Fired once the ROOT transaction has committed; dropped on rollback or a lost COMMIT. */
  onCommit(effect: () => void): void;
}

/**
 * The transaction this call runs inside, or `undefined`. `currentTx()` on purpose, FINISHED scopes
 * included: a promise chain the body forgot to await still finds the handle after the scope
 * closed, and `onCommit` on it runs the effect at once after a COMMIT and drops it after a
 * ROLLBACK — the answer `@ultimat3/entity`'s row observer gets from the same call, so a late bust
 * and a late change report never disagree about one write.
 */
export function openCommitScope(): CommitScope | undefined {
  return currentTx();
}

/** A transaction that is still OPEN: statements sent now are inside it. */
export interface LiveTransaction extends CommitScope {
  /** The client it was opened on — which DATABASE this is, compared by identity. */
  readonly origin: object;
  /** Fired when the scope rolls back; never after a commit. */
  onRollback(undo: () => void): void;
  /** `(text, values)` on the transaction's OWN connection. */
  readonly executor: PgExecutor;
}

/**
 * The open transaction, or `undefined` — outside one, and ALSO for a finished scope's handle. A
 * settlement bound to a transaction that already ended is bound to nothing: it would run as its
 * own commit while the record claimed otherwise, and that record is the one a retry may reclaim.
 *
 * The fragment is assembled by hand, exactly as `@ultimat3/cli`'s `pgExecutorFor` does: the caller
 * wrote the `$1..$n` text itself and hands over already-bound values.
 */
export function liveTransaction(): LiveTransaction | undefined {
  const tx = currentTx();
  if (tx === undefined || liveTxConnection() === undefined) return undefined;
  return {
    origin: tx.origin,
    onCommit: (effect) => tx.onCommit(effect),
    onRollback: (undo) => tx.onRollback(undo),
    executor: {
      query: <R>(text: string, values: readonly unknown[]) => tx.query<R>({ text, values }),
    },
  };
}
