/**
 * "A write just went through this tab's client": the one signal a page-side cache of server
 * answers (the client router's prefetched documents) needs to stop trusting them. Emitted by
 * `clientTransport` for every non-GET, landed or failed — a failed write may still have committed.
 * On `globalThis` under one `Symbol.for` key, like the page client: every bundle's copy of core
 * shares one listener set.
 */

const KEY = Symbol.for('ultimate.client-writes');

type Listener = (url: string) => void;

const listeners = (): Set<Listener> => {
  const host = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  let set = host[KEY];
  if (set === undefined) {
    set = new Set();
    host[KEY] = set;
  }
  return set;
};

/** Subscribe; returns the unsubscribe. A throwing listener never fails the write. */
export function onClientWrite(fn: Listener): () => void {
  const entry: Listener = (url) => fn(url);
  listeners().add(entry);
  return (): void => {
    listeners().delete(entry);
  };
}

export function notifyClientWrite(url: string): void {
  for (const listener of [...listeners()]) {
    try {
      listener(url);
    } catch {
      // A cache that could not clear is the listener's defect; the write itself stands.
    }
  }
}
