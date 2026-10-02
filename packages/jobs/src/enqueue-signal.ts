// "Work just arrived." A worker or relay that has backed off (`idle-backoff.ts`) is woken by it at
// once, so the backoff is never the latency of a job. Two signals, because they wake two loops: a
// job on the queue wakes workers, a row staged in the outbox wakes the relay. Raised in-process by
// whatever queued the work here, and by `queue-wake.ts` for work ANOTHER process committed — it
// holds the `LISTEN` this file knows nothing about.

function channel<A extends readonly unknown[]>(): {
  on(listener: (...args: A) => void): () => void;
  signal(...args: A): void;
} {
  const listeners = new Set<(...args: A) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signal(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

const enqueued = channel<[queue?: string]>();
const staged = channel<[committed?: boolean]>();

/** A job landed on `queue` — on any queue, when none is named. Returns the unsubscribe. */
export const onEnqueued = enqueued.on;
export const signalEnqueued = enqueued.signal;
/**
 * A row was staged in the outbox. `committed` is what tells the relay whether a pass NOW can find
 * it: a stage signalled by this process is still inside its transaction, one announced by
 * Postgres has committed.
 */
export const onStaged = staged.on;
export const signalStaged = staged.signal;

let live = false;

/**
 * Whether work committed by ANOTHER process reaches the two signals above — a `LISTEN` is held
 * and a notification has crossed it (`queue-wake.ts`). The idle loops read it to choose their
 * ceiling: with no wake, the poll is the only thing bounding a job's start.
 */
export const wakeIsLive = (): boolean => live;

export function setWakeLive(value: boolean): void {
  live = value;
}
