// Single responsibility: the in-memory `Transactor`. Undo closures a driver registered run on a
// throw, commit effects after the work succeeded. Beside `memory-repo.ts` rather than in it, because
// the lock needs a transaction and the repository needs the lock.

import type { Transactor, Tx } from './repo';

let txCounter = 0;

/** In-memory transactor: undo closures registered by drivers run on failure. */
export const memoryTransactor = (): Transactor => ({
  async run(work) {
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
      result = await work(tx);
    } catch (error) {
      for (const undo of undos.reverse()) undo();
      throw error;
    }
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
