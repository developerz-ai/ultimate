// One serial lane per live query id, over that query's shared window.
//
// The window is a read-modify-write across awaits — match, apply, append, then one policy pass per
// subscriber — and nothing upstream orders the callers: `sync` fires `void registry.deliver(change)`
// straight off the bus. Two of those interleaving is one subscriber shown lsn 2 before lsn 1, its
// cursor then rewound to 1, and a gate deciding about a row against a window that has moved past it.

/** FIFO, one task at a time. A task that rejects hands its rejection to its own caller and no one else. */
export class WindowLock {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /**
   * Tasks queued or running. What a caller bounds the lane by (`live-deliver.ts`): every task is
   * a closure holding its change, so a lane behind one slow policy pass is memory nobody capped.
   */
  get depth(): number {
    return this.#depth;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(work);
    // The lane chains on a settled shadow, never on `result`: one delivery that threw must not
    // reject every delivery queued behind it, and an unwatched shadow must not look unhandled.
    this.#tail = result.then(this.#settled, this.#settled);
    return result;
  }

  readonly #settled = (): void => {
    this.#depth -= 1;
  };
}
