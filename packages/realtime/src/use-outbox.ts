// The page outbox's count, as a getter a component reads: how many writes wait to be sent. Read
// off the outbox the boot seated (`outbox-slot.ts`), never built here, so an island asking ships
// the slot and none of the queue. A server render holds nothing queued.

import { peekOutbox } from './outbox-slot';
import { installedPage } from './page-store';
import { isServerRender, signalFor } from './reactivity';

export interface OutboxView extends Disposable {
  /** Stop listening (Solid: `onCleanup`). The outbox itself stays, and keeps its writes. */
  release(): void;
  /** Writes queued and not yet taken by the server; `0` before the boot has opened the outbox. */
  readonly size: number;
}

const SERVER_RENDER: OutboxView = Object.freeze({
  release: (): void => undefined,
  [Symbol.dispose]: (): void => undefined,
  size: 0,
});

export function useOutbox(): OutboxView {
  const signal = signalFor('useOutbox');
  if (isServerRender()) return SERVER_RENDER;
  const page = installedPage('useOutbox');
  const [version, setVersion] = signal(0);
  const moved = (): void => setVersion(version() + 1);
  let unsubscribe: () => void = () => undefined;
  let released = false;
  // After the boot: it seats the outbox, and a queue a previous load left is on disk until then.
  void page.booted.then(() => {
    const outbox = peekOutbox();
    if (released || outbox === undefined) return;
    unsubscribe = outbox.subscribe(moved);
    moved();
  });
  const release = (): void => {
    released = true;
    unsubscribe();
  };
  return {
    release,
    [Symbol.dispose]: release,
    get size() {
      version();
      return peekOutbox()?.size ?? 0;
    },
  };
}
