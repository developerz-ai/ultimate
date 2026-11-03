// Single responsibility: the memory driver's one-statement promise for a batch judged as it lands.
// Postgres refuses a statement as one; rows the memory driver can only judge one at a time are
// undone here when a later one is refused, and handed to the surrounding `tx` when none is.

import type { Tx } from './repo';

/**
 * `work` under a scope collecting its undos: run on a throw or a rejection, handed to `tx` when it
 * succeeds. An effect with nowhere to wait runs at once, what `Tx.onCommit` promises a bare `Tx`.
 * Async work settles the scope when it settles; a lock's savepoint is this scope too.
 */
export const undoingBatch = <T>(tx: Tx | undefined, work: (scope: Tx) => T): T => {
  const undos: (() => void)[] = [];
  const undo = (): void => {
    for (const each of undos.reverse()) each();
    undos.length = 0;
  };
  const handUp = (): void => {
    for (const each of undos) tx?.onRollback(each);
  };
  const scope: Tx = {
    id: tx?.id ?? 'batch',
    onRollback: (each) => undos.push(each),
    onCommit: (effect) => (tx?.onCommit === undefined ? effect() : tx.onCommit(effect)),
  };
  try {
    const result = work(scope);
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          handUp();
          return value;
        },
        (error: unknown) => {
          undo();
          throw error;
        },
      ) as T;
    }
    handUp();
    return result;
  } catch (error) {
    undo();
    throw error;
  }
};
