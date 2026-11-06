/**
 * The open database transaction, as this package needs it — **the only** file here that imports
 * `@ultimat3/db` (`tx-scope.test.ts` holds that). When is a write durable (`openCommitScope`, the
 * cache bust), and is a transaction really OPEN, on which client (`liveTransaction`, idempotency).
 * And a scope whose writes are never kept (`inRolledBackScope`, the contract step's exercise).
 */

// Type-only: `idempotency-postgres.ts` imports this module, and a runtime edge would be a cycle.
import type { PgExecutor } from '@ultimat3/core';
import { storeMode } from '@ultimat3/core';
import {
  completeTransaction,
  currentTx,
  dbClientInstalled,
  liveTxConnection,
  withTransaction,
} from '@ultimat3/db';
import { memoryJournal, memoryTransactor } from '@ultimat3/entity';

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
 * and a late change report never disagree about one write. With no SQL transaction, the open
 * MEMORY transaction answers the same way (the row observer asks it too).
 */
export function openCommitScope(): CommitScope | undefined {
  const sql = currentTx();
  if (sql !== undefined) return sql;
  const memory = memoryJournal();
  const onCommit = memory?.onCommit?.bind(memory);
  return onCommit === undefined ? undefined : { onCommit };
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

/** Whether a SQL transaction can hold the writes: one is open, or a client is installed. */
const sqlScopeAvailable = (): boolean => liveTxConnection() !== undefined || dbClientInstalled();

/**
 * Whether `inRolledBackScope` undoes the writes: a SQL transaction can hold them, or the store is
 * memory (`storeMode`, `test`), whose writes the memory transaction it always opens holds.
 */
export const rollbackAvailable = (): boolean =>
  sqlScopeAvailable() || storeMode(Bun.env) === 'memory';

/**
 * `run` inside a transaction that ALWAYS rolls back — a memory transaction, always, so a memory
 * store write is undone however the handler wrote it; and in it a SAVEPOINT when a SQL transaction
 * is already open (a test's own scope), a root BEGIN when a test installed a client. The outbox
 * stage and the post-commit bust ride the SQL transaction, so they drop with it. A write made
 * outside both (a second client, `outsideTransaction`) is not undone.
 */
export async function inRolledBackScope<T>(run: () => Promise<T>): Promise<Settled<T>> {
  let settled: Settled<T> | undefined;
  const settleThenRollBack = async (): Promise<never> => {
    try {
      settled = { ok: true, value: await run() };
    } catch (error) {
      settled = { ok: false, error };
    }
    throw ROLLBACK;
  };
  try {
    // One ROLLBACK ends both: thrown out of the SQL scope, it carries on through the memory one.
    await memoryTransactor().run(() =>
      sqlScopeAvailable() ? withTransaction(settleThenRollBack) : settleThenRollBack(),
    );
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  // `settleThenRollBack` assigns before it throws, so a scope that ended on ROLLBACK assigned it.
  return settled ?? { ok: false, error: ROLLBACK };
}
