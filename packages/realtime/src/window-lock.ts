// One serial lane per live query id, over that query's shared window.
//
// The window is a read-modify-write across awaits — match, apply, append, then one policy pass per
// subscriber — and nothing upstream orders the callers: `sync` fires `void registry.deliver(change)`
// straight off the bus. Two of those interleaving is one subscriber shown lsn 2 before lsn 1, its
// cursor then rewound to 1, and a gate deciding about a row against a window that has moved past it.

/** FIFO, one task at a time. A task that rejects hands its rejection to its own caller and no one else. */
export class WindowLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    // The lane chains on a settled shadow, never on `result`: one delivery that threw must not
    // reject every delivery queued behind it, and an unwatched shadow must not look unhandled.
    this.#tail = result.then(ignore, ignore);
    return result;
  }
}

const ignore = (): void => undefined;
