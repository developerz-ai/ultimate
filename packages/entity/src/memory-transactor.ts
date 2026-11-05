// Single responsibility: the in-memory `Transactor`. Undo closures a driver registered run on a
// throw, commit effects after the work succeeded. Beside `memory-repo.ts` rather than in it, because
// the lock needs a transaction and the repository needs the lock.

import { inMemoryJournal, memoryJournal } from './memory-journal';
import type { Transactor, Tx } from './repo';

let txCounter = 0;

/**
 * In-memory transactor: undo closures registered by drivers run on failure. Ambient, as
 * `withTransaction` is: a write inside `work` that names no `tx` joins this one. Nested, a commit is
 * a savepoint's release — its undos move to the enclosing transaction.
 */
export const memoryTransactor = (): Transactor => ({
  async run(work) {
    const outer = memoryJournal();
    const undos: (() => void)[] = [];
    const commits: (() => void)[] = [];
    txCounter += 1;
    const tx: Tx = {
      id: `tx-${txCounter}`,
      onRollback: (undo) => undos.push(undo),
      onCommit: (effect) => commits.push(effect),
    };
    let result: Awaited<ReturnType<typeof work>>;
    try {
      result = await inMemoryJournal(tx, () => work(tx));
    } catch (error) {
      for (const undo of undos.reverse()) undo();
      throw error;
    }
    // Its effects still run at once when nested — a lock's release is one, and holding it to the
    // outer end would stall the next write to the same row in the same transaction.
    if (outer !== undefined) for (const undo of undos) outer.onRollback(undo);
    // After the work succeeded — the memory "commit" — and best-effort, as `@ultimat3/db` runs them.
    for (const effect of commits) {
      try {
        effect();
      } catch {
        // an effect is a report about a durable write; it may not fail the write
      }
    }
    return result;
  },
});
