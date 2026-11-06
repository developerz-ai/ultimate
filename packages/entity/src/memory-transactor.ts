// Single responsibility: the in-memory `Transactor`. Undo closures a driver registered run on a
// throw, commit effects after the ROOT succeeded, and a write that outlives the scope is refused as
// `@ultimat3/db` refuses a statement on a finished transaction. Beside `memory-repo.ts` rather than
// in it, because the lock needs a transaction and the repository needs the lock.

import {
  enrolMemoryTx,
  inMemoryJournal,
  type MemoryOutcome,
  memoryJournal,
  memoryOutcomeOf,
  memoryRoot,
  memoryTxClosed,
  outsideMemoryJournal,
  refuseIfMemoryTxClosed,
} from './memory-journal';
import type { Transactor, Tx } from './repo';

let txCounter = 0;

/** Best-effort and off the journal, as `@ultimat3/db` runs them: the work is already durable. */
const runEffects = (effects: readonly (() => void)[]): void =>
  outsideMemoryJournal(() => {
    for (const effect of effects) {
      try {
        effect();
      } catch {
        // an effect is a report about a durable write; it may not fail the write
      }
    }
  });

/**
 * In-memory transactor: undo closures registered by drivers run on failure. Ambient, as
 * `withTransaction` is: a write inside `work` that names no `tx` joins this one. Nested, a commit is
 * a savepoint's release — its undos and its effects move to the enclosing transaction, so an effect
 * runs only once the root commits and never after the root rolls back.
 *
 * Ended, the scope still rides every promise `work` forgot to await. A write there is refused
 * (`X_DB_TRANSACTION_CLOSED`) once the root has ended; on a nested handle while the root is open it
 * is the enclosing transaction's, as a statement on a released savepoint's handle is in Postgres.
 * An effect registered after the root ended runs at once after a COMMIT and never after a ROLLBACK.
 */
export const memoryTransactor = (): Transactor => ({
  async run(work) {
    const outer = memoryJournal();
    refuseIfMemoryTxClosed(outer);
    const outcome: MemoryOutcome = (outer && memoryOutcomeOf(outer)) ?? { value: 'open' };
    const undos: (() => void)[] = [];
    const commits: (() => void)[] = [];
    let ended = false;
    txCounter += 1;
    const id = `tx-${txCounter}`;
    const tx: Tx = {
      id,
      onRollback: (undo) => {
        if (outcome.value !== 'open') throw memoryTxClosed(id, outcome.value);
        if (!ended) undos.push(undo);
        else outer?.onRollback(undo);
      },
      onCommit: (effect) => {
        if (outcome.value === 'committed') runEffects([effect]);
        else if (outcome.value === 'rolled-back') return;
        else if (!ended) commits.push(effect);
        else outer?.onCommit?.(effect);
      },
    };
    enrolMemoryTx(tx, outer === undefined ? tx : memoryRoot(outer), outcome);
    let result: Awaited<ReturnType<typeof work>>;
    try {
      result = await inMemoryJournal(tx, () => work(tx));
    } catch (error) {
      ended = true;
      if (outer === undefined) outcome.value = 'rolled-back';
      for (const undo of undos.reverse()) undo();
      throw error;
    }
    ended = true;
    if (outer === undefined) {
      outcome.value = 'committed';
      runEffects(commits);
      return result;
    }
    // The root ended while this savepoint ran: its RELEASE is refused, and its rows went where the
    // root went — kept by a commit, undone here after a rollback, whose undos never saw them.
    if (outcome.value !== 'open') {
      if (outcome.value === 'rolled-back') for (const undo of undos.reverse()) undo();
      throw memoryTxClosed(id, outcome.value);
    }
    for (const undo of undos) outer.onRollback(undo);
    for (const effect of commits) outer.onCommit?.(effect);
    return result;
  },
});
