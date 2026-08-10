// Single responsibility: taking turns on PGlite's one connection. Embedded Postgres is a single
// session, not a pool, so two units of work that each `BEGIN` would be sharing one transaction —
// the second `COMMIT` commits the first's uncommitted rows and the first `ROLLBACK` finds nothing
// to undo. This queue makes them consecutive instead, which is what a pinned pool connection
// gives `withTransaction` and `readOnlyQuery` on a real server.

/** Gives the connection back. Idempotent — a double release must not hand out two turns. */
export type Turn = () => void;

export interface TurnQueue {
  /** Wait for the connection, then keep it until the returned `Turn` is called. */
  take(): Promise<Turn>;
  /** Take a turn, run, give it back — the whole life of a single statement. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * FIFO, because the tail is the only thing a new caller waits on and every caller extends it in
 * the order it arrived. The tail never rejects: a turn whose work threw must still be the turn
 * the next caller waits for, or one failed statement strands the connection for the process.
 */
export function createTurnQueue(): TurnQueue {
  let tail: Promise<void> = Promise.resolve();

  async function take(): Promise<Turn> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = tail;
    // Claim the slot before awaiting: two synchronous `take()` calls must queue behind each
    // other, not both read the same tail and run at once.
    tail = mine.then(() => held);
    await mine;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    const turn = await take();
    try {
      return await work();
    } finally {
      turn();
    }
  }

  return { take, run };
}
