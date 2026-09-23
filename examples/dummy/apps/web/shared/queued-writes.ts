/**
 * How many of this island's writes the page's OUTBOX holds — what "this will be sent when you
 * reconnect" is a statement about.
 *
 * Read off `useMutation`'s answer, which resolves `undefined` exactly when the write got no
 * response and was queued (`packages/realtime/src/use-mutation.ts`). Not `mutate.pending`, which
 * counts writes IN FLIGHT and returns to zero the moment one is queued, and not
 * `useConnection().offline`, which is the socket's state — an open socket survives the browser
 * going offline. Cleared on the browser's `online`, which is the event the outbox replays on
 * (`page-outbox.ts`), so the notice leaves when the send it promised starts.
 */

import { createSignal, onCleanup } from 'solid-js';

export interface QueuedWrites {
  /** Writes queued since the last `online`. */
  readonly count: () => number;
  /** Hand it the write's promise; a refusal is swallowed — the overlay was already taken back. */
  readonly track: (write: Promise<unknown>) => Promise<void>;
}

export function trackQueued(): QueuedWrites {
  const [count, setCount] = createSignal(0);
  const clear = (): void => {
    setCount(0);
  };
  globalThis.addEventListener('online', clear);
  onCleanup(() => globalThis.removeEventListener('online', clear));
  return {
    count,
    track: (write) =>
      write.then(
        (answer) => {
          if (answer === undefined) setCount((n) => n + 1);
        },
        () => undefined,
      ),
  };
}
