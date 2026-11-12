// Every `use*` hook releases itself when its component goes: the island bootstrap installs Solid's
// `onCleanup` as `cleanup`, and an island that never wrote `onCleanup(() => h.release())` still
// leaves the page's socket subscriptions, store listeners and holds as they were before it mounted.
// `owner` stands in for a Solid root: what `cleanup` registered runs on `dispose()`.

import { afterEach, describe, expect, test } from 'bun:test';
import type { SignalFactory } from './client-contract';
import { flush, liveFeed, pageHarness, querySids, resetPage, signal } from './hooks-fixture';
import { OUTBOX_KEY, type OutboxHandle } from './outbox-slot';
import { installRealtime, ownedRelease } from './reactivity';
import { useChannel, usePresence } from './use-channel';
import { useConnection } from './use-connection';
import { useMutation, useMutationQueue } from './use-mutation';
import { useOutbox } from './use-outbox';
import { useQuery } from './use-query';
import { useRecord, useRecords } from './use-record';
import { useRecordChanges } from './use-record-changes';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, OUTBOX_KEY);
  resetPage();
});

/** A component's owner: `cleanup` registers, `dispose` runs what was registered, once. */
function owner(): { readonly cleanup: (fn: () => void) => void; dispose(): void } {
  const registered: (() => void)[] = [];
  return {
    cleanup: (fn) => {
      registered.push(fn);
    },
    dispose: () => {
      for (const fn of registered.splice(0)) fn();
    },
  };
}

/** Every setter call of every signal a hook made: after dispose, nothing may move one. */
function countingSignal(): { readonly factory: SignalFactory; readonly sets: () => number } {
  let sets = 0;
  const factory: SignalFactory = <T>(initial: T) => {
    const [read, write] = signal(initial);
    return [
      read,
      (next: T) => {
        sets += 1;
        write(next);
      },
    ];
  };
  return { factory, sets: () => sets };
}

/** The outbox the boot opened, standing in, counting who listens to it. */
function seatOutbox(): { readonly listeners: () => number } {
  const listeners = new Set<() => void>();
  const handle: OutboxHandle = {
    enqueue: async () => undefined,
    replay: async () => undefined,
    pending: () => [],
    size: 0,
    refresh: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: Promise.resolve(),
  };
  Object.defineProperty(globalThis, OUTBOX_KEY, { value: handle, configurable: true });
  return { listeners: () => listeners.size };
}

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};
const presenceFeed = { ...orgFeed, name: 'room', topic: () => 'room.r1' };

const channelOps = (frames: readonly { type: string; target?: { kind: string } }[]): number =>
  frames.filter((frame) => frame.type === 'subscribe' && frame.target?.kind === 'channel').length;

describe('a hook releases itself through the installed cleanup', () => {
  test('an island mounted then disposed with no explicit release leaves the page as it was', async () => {
    const { page, socket } = pageHarness();
    socket.open();
    const outbox = seatOutbox();
    const counted = countingSignal();
    const root = owner();
    installRealtime({ signal: counted.factory, cleanup: root.cleanup });
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const sizeBefore = page.store.size;
    const writersBefore = page.writes.listeners.size;
    let changes = 0;

    // The island's body: every hook, and not one `onCleanup`.
    useQuery(liveFeed, {});
    useChannel(orgFeed, { orgId: 'o1' });
    usePresence(presenceFeed, {});
    useConnection();
    useOutbox();
    useRecord('posts', 'p1');
    useRecords('posts', ['p1']);
    useRecords('posts', {});
    useRecordChanges(['posts'], () => {
      changes += 1;
    });
    useMutation({ name: 'likePost' });
    useMutationQueue();
    await flush();
    expect(outbox.listeners()).toBe(1);
    expect(page.writes.listeners.size).toBe(writersBefore + 2);

    root.dispose();
    // The socket: the live query and both channels dropped — one `drop` each.
    expect(querySids(socket, 'drop')).toHaveLength(1);
    expect(channelOps(socket.frames())).toBe(4);
    // The page: no listener left on the writes or the outbox.
    expect(page.writes.listeners.size).toBe(writersBefore);
    expect(outbox.listeners()).toBe(0);
    // Nothing moves a signal of the disposed island: not the store, not the socket's status.
    const sets = counted.sets();
    page.store.adopt('posts', { p1: { id: 'p1', likes: 2 }, p2: { id: 'p2', likes: 0 } });
    socket.close();
    expect(counted.sets()).toBe(sets);
    expect(changes).toBe(1);
    // No hold left behind: the store keeps only what it held before the mount, plus p2's adopt.
    expect(page.store.size).toBe(sizeBefore + 1);
  });

  test('a non-live read disposed after its answer: a write to its record moves nothing', async () => {
    const { page } = pageHarness();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'p1' }], records: { posts: { p1: { id: 'p1' } } } }),
        { status: 200, headers: { 'x-ultimate-records': '1' } },
      )) as unknown as typeof fetch;
    const counted = countingSignal();
    const root = owner();
    installRealtime({ signal: counted.factory, cleanup: root.cleanup });
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1' }] });

    root.dispose();
    const sets = counted.sets();
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    expect(counted.sets()).toBe(sets);
  });

  test('an explicit release and the owner both firing release ONCE', () => {
    const { page, socket } = pageHarness();
    socket.open();
    const root = owner();
    installRealtime({ signal, cleanup: root.cleanup });
    const other = useChannel(orgFeed, { orgId: 'o1' });
    const live = useQuery(liveFeed, {});
    live.release();
    root.dispose();
    expect(querySids(socket, 'drop')).toHaveLength(1);
    // `other` was registered on the same owner: still one membership add and one drop.
    expect(channelOps(socket.frames())).toBe(2);
    other.release();
    expect(channelOps(socket.frames())).toBe(2);
    expect(page.writes.listeners.size).toBe(0);
  });

  test('ownedRelease: the owner and two release() calls run the release once', () => {
    pageHarness();
    const root = owner();
    installRealtime({ signal, cleanup: root.cleanup });
    let runs = 0;
    const release = ownedRelease(() => {
      runs += 1;
    });
    release();
    root.dispose();
    release();
    expect(runs).toBe(1);
  });

  test('a hook made outside any owner is the caller’s: nothing releases it but release()', () => {
    const { socket } = pageHarness();
    socket.open();
    installRealtime({ signal });
    const live = useQuery(liveFeed, {});
    expect(querySids(socket, 'drop')).toHaveLength(0);
    live.release();
    expect(querySids(socket, 'drop')).toHaveLength(1);
  });
});
