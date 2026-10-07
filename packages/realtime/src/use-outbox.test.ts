// `useOutbox()`: the page outbox's count as a reactive read — what an island's "this will be sent
// when you reconnect" notice is a statement about. It reads the outbox the boot seated, never
// builds one, so an island that asks carries the slot and not the queue.

import { afterEach, describe, expect, test } from 'bun:test';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import { OUTBOX_KEY, type OutboxEntry, type OutboxHandle } from './outbox-slot';
import { useOutbox } from './use-outbox';

afterEach(() => {
  resetPage();
});

/** The outbox the boot opened, standing in: `queued` writes, and a way to move the count. */
function seatOutbox(): OutboxHandle & { queue(entry: OutboxEntry): void; listeners: number } {
  const held: OutboxEntry[] = [];
  const listeners = new Set<() => void>();
  const handle = {
    enqueue: async (entry: OutboxEntry) => {
      held.push(entry);
      for (const listener of listeners) listener();
    },
    replay: async () => undefined,
    pending: () => held,
    get size() {
      return held.length;
    },
    refresh: async () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: Promise.resolve(),
    queue(entry: OutboxEntry) {
      void handle.enqueue(entry);
    },
    get listeners() {
      return listeners.size;
    },
  };
  Object.defineProperty(globalThis, OUTBOX_KEY, { value: handle, configurable: true });
  return handle;
}

describe('useOutbox', () => {
  test('follows the count the outbox holds, and lets go on release', async () => {
    pageHarness();
    const outbox = seatOutbox();
    const view = useOutbox();
    await flush();
    expect(view.size).toBe(0);
    outbox.queue({ key: 'likePost:1', name: 'likePost', input: {} });
    expect(view.size).toBe(1);
    expect(outbox.listeners).toBe(1);
    view.release();
    expect(outbox.listeners).toBe(0);
  });

  test('a page with no outbox seated holds nothing queued', async () => {
    pageHarness();
    const view = useOutbox();
    await flush();
    expect(view.size).toBe(0);
  });

  test('a server render answers an empty outbox and touches no page', () => {
    resetPage();
    const hadDocument = Reflect.has(globalThis, 'document');
    expect(hadDocument).toBe(false);
    expect(useOutbox().size).toBe(0);
  });
});
