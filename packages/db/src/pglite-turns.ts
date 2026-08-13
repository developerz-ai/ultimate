// Single responsibility: taking turns on PGlite's one connection. Embedded Postgres is a single
// session, not a pool, so two units of work that each `BEGIN` would be sharing one transaction —
// the second `COMMIT` commits the first's uncommitted rows and the first `ROLLBACK` finds nothing
// to undo. This queue makes them consecutive instead, which is what a pinned pool connection
// gives `withTransaction` and `readOnlyQuery` on a real server.

/**
 * Gives the connection back. `release()` is idempotent for free: it is a settled promise's
 * `resolve`, not a counter, so a second call cannot hand out a second turn — the next caller is
 * already awake. `Disposable`, so `using turn = await queue.take()` gives it back on every exit
 * path — the same shape as `DbConnection` in `client.ts`, and `[Symbol.dispose]` is `release()`
 * itself, never a second code path.
 */
export interface Turn extends Disposable {
  release(): void;
}

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
    return { release, [Symbol.dispose]: release };
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    // `using`, not `try`/`finally`: the turn must go back on every exit path, including one a
    // future edit adds above a hand-rolled `finally` that forgot it — see `client.ts`.
    using _turn = await take();
    return await work();
  }

  return { take, run };
}
