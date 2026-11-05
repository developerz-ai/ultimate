/**
 * The open database transaction, as this package needs it — **the only** file here that imports
 * `@ultimat3/db` (`tx-scope.test.ts` holds that). When is a write durable (`openCommitScope`, the
 * cache bust), and is a transaction really OPEN, on which client (`liveTransaction`, idempotency).
 * And a scope whose writes are never kept (`inRolledBackScope`, the contract step's exercise).
 */

// Type-only: `idempotency-postgres.ts` imports this module, and a runtime edge would be a cycle.
import type { PgExecutor } from '@ultimat3/core';
import {
  completeTransaction,
  currentTx,
  dbClientInstalled,
  liveTxConnection,
  withTransaction,
} from '@ultimat3/db';

/** The mark a keyed run puts on the open root: its COMMIT carries the settle, abort or no abort. */
export const carrySettleOnCommit = (): void => completeTransaction();

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
 * The fragment is assembled by hand, exactly as `@ultimat3/db`'s `dbExecutor` does: the caller
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

/**
 * Thrown inside the scope only to end it, and caught right outside: the one way a `withTransaction`
 * body asks for ROLLBACK. Never an `UltimateError`, because nothing but `inRolledBackScope` ever
 * sees it — a code would be a failure mode no caller can meet.
 */
const ROLLBACK: unique symbol = Symbol('ultimate.action.rollback');

/** What `run` settled to inside the scope, carried past the rollback that ends it. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * `run` inside a transaction that ALWAYS rolls back — a SAVEPOINT when one is already open (a
 * test's own scope), a root BEGIN when a test installed a client, and no scope at all when there
 * is no database to write to. The outbox stage and the post-commit bust ride the transaction, so
 * they drop with it. A write made outside it (a second client, `outsideTransaction`) is not undone.
 */
export async function inRolledBackScope<T>(run: () => Promise<T>): Promise<Settled<T>> {
  const settle = async (): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  if (liveTxConnection() === undefined && !dbClientInstalled()) return settle();
  let settled: Settled<T> | undefined;
  try {
    await withTransaction(async () => {
      settled = await settle();
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  // `settle` never throws, so a scope that ended on ROLLBACK always assigned it.
  return settled ?? { ok: false, error: ROLLBACK };
}
