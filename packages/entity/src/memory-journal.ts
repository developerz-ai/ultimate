// Single responsibility: the memory transaction this async chain is inside, ambient as
// `@ultimat3/db`'s `withTransaction` is — a write that names no `tx` joins it, so a handler that
// passes none is still undone when the transaction rolls back — and whether that one has ENDED: the
// async chain outlives the scope, so the store's presence is not an open transaction.

import { asyncContext } from '@ultimat3/core';
import { DbError } from '@ultimat3/db';
import type { Tx } from './repo';

/** How the ROOT ended, shared by reference across nesting, as `@ultimat3/db`'s `TxOutcome` is. */
export interface MemoryOutcome {
  value: 'open' | 'committed' | 'rolled-back';
}

/** Each memory `Tx` handed out, its root and the root's outcome: a hand-written `Tx` has none. */
interface Scope {
  readonly root: Tx;
  readonly outcome: MemoryOutcome;
}

const journal = asyncContext<Tx>('an open memory transaction');
const scopes = new WeakMap<Tx, Scope>();

/** The open memory transaction this async chain writes under, or `undefined` outside one. */
export const memoryJournal = (): Tx | undefined => journal.get();

/** `work` with `tx` as the ambient memory transaction. `memoryTransactor` is the one caller. */
export const inMemoryJournal = <T>(tx: Tx, work: () => T): T => journal.run(tx, work);

/** `work` under no memory transaction: an effect after COMMIT writes as its own unit of work. */
export const outsideMemoryJournal = <T>(work: () => T): T => journal.exit(work);

/** Files `tx` under its root. `memoryTransactor` is the one caller. */
export const enrolMemoryTx = (tx: Tx, root: Tx, outcome: MemoryOutcome): void => {
  scopes.set(tx, { root, outcome });
};

/** The outcome a memory `tx` shares with its root, or `undefined` for any other `Tx`. */
export const memoryOutcomeOf = (tx: Tx): MemoryOutcome | undefined => scopes.get(tx)?.outcome;

/** `scope` — a batch or a lock's savepoint over `tx` — answers to `tx`'s root, when it has one. */
export const enrolMemoryScope = (scope: Tx, tx: Tx | undefined): void => {
  const parent = tx === undefined ? undefined : scopes.get(tx);
  if (parent !== undefined) scopes.set(scope, parent);
};

/** The root a memory `tx` belongs to — what a lock is held to — or `tx` itself for any other. */
export const memoryRoot = (tx: Tx): Tx => scopes.get(tx)?.root ?? tx;

/**
 * The same refusal a statement on a finished `DbTx` meets (`X_DB_TRANSACTION_CLOSED`): one mistake,
 * one code on both drivers. The cause names the memory scope, because that is what outlived it.
 */
export const memoryTxClosed = (id: string, outcome: string): DbError =>
  new DbError({
    code: 'X_DB_TRANSACTION_CLOSED',
    cause: `a write was sent on memory transaction ${id} after its scope ended (${outcome}): an un-awaited promise, or the loser of a Promise.all, outlived memoryTransactor().run, and it was never part of that unit of work`,
    fix: 'await memoryTransactor().run(async () => { await repo.insert(row); })   # await every write inside the body; one meant to outlive the scope goes after run() resolves',
    meta: { tx: id, outcome },
  });

/** Refuses a write on a memory `tx` whose root has ended; any other `tx` passes. */
export const refuseIfMemoryTxClosed = (tx: Tx | undefined): void => {
  const scope = tx === undefined ? undefined : scopes.get(tx);
  if (tx !== undefined && scope !== undefined && scope.outcome.value !== 'open') {
    throw memoryTxClosed(tx.id, scope.outcome.value);
  }
};
