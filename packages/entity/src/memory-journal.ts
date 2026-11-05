// Single responsibility: the memory transaction this async chain is inside, ambient as
// `@ultimat3/db`'s `withTransaction` is — a write that names no `tx` joins it, so a handler that
// passes none is still undone when the transaction rolls back.

import { asyncContext } from '@ultimat3/core';
import type { Tx } from './repo';

const journal = asyncContext<Tx>('an open memory transaction');

/** The open memory transaction this async chain writes under, or `undefined` outside one. */
export const memoryJournal = (): Tx | undefined => journal.get();

/** `work` with `tx` as the ambient memory transaction. `memoryTransactor` is the one caller. */
export const inMemoryJournal = <T>(tx: Tx, work: () => T): T => journal.run(tx, work);
