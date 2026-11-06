// Single responsibility: the memory driver's lock. A promise queue per key, reentrant within one
// async chain, and bounded: Postgres has `statement_timeout` for a stuck waiter and deadlock
// detection for a cycle, and this driver has neither, so a wait that lasts is the refusal instead.

import { asyncContext } from '@ultimat3/core';
import { driverError } from '@ultimat3/db';
import { undoingBatch } from './memory-batch';
import { memoryJournal, memoryRoot, refuseIfMemoryTxClosed } from './memory-journal';
import { memoryTransactor } from './memory-transactor';
import type { Tx } from './repo';

/** Past this a waiter gives up. Generous for a test, and a cycle reaches it every time. */
export const MEMORY_LOCK_WAIT_MS = 5_000;

export interface MemoryLocks {
  /**
   * `work` under `key`, in a transaction: its own, or joined as a savepoint to `outer`, or to the
   * one this async chain's lock already opened. Joined, the key is held to that transaction's end,
   * because a Postgres lock taken in a savepoint lives to the root.
   */
  run<R>(key: string, outer: Tx | undefined, work: (tx: Tx) => Promise<R> | R): Promise<R>;
  /**
   * A plain write's turn at `key`, the wait an `update` does for a row lock on Postgres: waits for a
   * holder, runs `work`, holds nothing after it. No wait when this chain or `outer` holds the key.
   */
  turn<R>(key: string, outer: Tx | undefined, work: () => R): Promise<R>;
}

/** What this async chain holds, and the transaction its innermost lock runs in. */
interface Chain {
  readonly names: ReadonlySet<string>;
  readonly tx: Tx;
}

const heldByChain = asyncContext<Chain>('the memory locks this chain holds');

let instances = 0;

/** `57014`, what a Postgres waiter past its `statement_timeout` is: one code for one mistake. */
const timedOut = (key: string, waitMs: number): Error =>
  driverError(`memory lock "${key}"`, {
    code: '57014',
    message: `canceling statement: waited ${waitMs} ms for a lock another caller still holds, usually two locks taken in opposite order`,
  });

export const memoryLocks = (waitMs: number = MEMORY_LOCK_WAIT_MS): MemoryLocks => {
  instances += 1;
  const instance = instances;
  /** The last holder's end, per key: a newcomer waits on it and becomes the new end. */
  const tails = new Map<string, Promise<void>>();
  /** What a joined scope still holds once it returned, per ROOT: same root, same key, no wait. */
  const heldByTx = new WeakMap<Tx, Set<string>>();

  const inTx = <R>(outer: Tx | undefined, work: (tx: Tx) => Promise<R> | R): Promise<R> =>
    outer === undefined
      ? memoryTransactor().run(async (tx) => work(tx))
      : Promise.resolve(undoingBatch(outer, work));

  const acquire = async (name: string): Promise<() => void> => {
    const previous = tails.get(name);
    const mine = Promise.withResolvers<void>();
    const tail = (previous ?? Promise.resolve()).then(() => mine.promise);
    tails.set(name, tail);
    // Off the tail, never off `release`: a waiter giving up has released, while the tail it joined
    // still ends with the live holder, and a newcomer has to queue behind that holder.
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    const release = (): void => mine.resolve();
    if (previous === undefined) return release;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(timedOut(name, waitMs)), waitMs);
    });
    try {
      await Promise.race([previous, bound]);
      return release;
    } catch (error) {
      // Its place in the queue is given up, so the waiter behind it is not held by a ghost.
      release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const holds = (name: string, chain: Chain | undefined, outer: Tx | undefined): boolean =>
    chain?.names.has(name) === true ||
    (outer !== undefined && heldByTx.get(memoryRoot(outer))?.has(name)) === true;

  return {
    async run(key, given, work) {
      const name = `${instance}:${key}`;
      const chain = heldByChain.get();
      // The ambient memory transaction last: a lock taken in one is a savepoint of it, held to its
      // root's end. Its own transaction instead released at that one's commit, and the root's
      // rollback then overwrote what the next holder had committed.
      const outer = given ?? chain?.tx ?? memoryJournal();
      // Before the wait, as a statement on a finished transaction is refused before it is sent.
      refuseIfMemoryTxClosed(outer);
      // `work` runs knowing its own tx, so a lock nested in it with no options joins this one.
      const body =
        <R>(step: (tx: Tx) => Promise<R> | R) =>
        (tx: Tx) =>
          heldByChain.run({ names: new Set([...(chain?.names ?? []), name]), tx }, () => step(tx));
      if (holds(name, chain, outer)) return inTx(outer, body(work));
      const release = await acquire(name);
      // Held to the root's end when there is one that can say so. A hand-written `Tx` with no
      // `onCommit` cannot, and the scope's own end is the only moment left.
      if (outer?.onCommit !== undefined) {
        // Filed under the root, so any scope of it finds the key; released by `outer`'s end, which
        // for a savepoint that commits is the root's, and for one that rolls back is its own.
        const root = memoryRoot(outer);
        const held = heldByTx.get(root) ?? new Set<string>();
        held.add(name);
        heldByTx.set(root, held);
        const once = (): void => {
          held.delete(name);
          release();
        };
        outer.onCommit(once);
        outer.onRollback(once);
        return inTx(outer, body(work));
      }
      try {
        return await inTx(outer, body(work));
      } finally {
        release();
      }
    },

    async turn(key, outer, work) {
      const name = `${instance}:${key}`;
      const chain = heldByChain.get();
      if (holds(name, chain, outer ?? chain?.tx ?? memoryJournal())) return work();
      const release = await acquire(name);
      try {
        return work();
      } finally {
        release();
      }
    },
  };
};
