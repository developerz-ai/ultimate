// A write made while the browser KNOWS it is offline (#777): it is on disk before it is on screen.
// It used to paint first and reach IndexedDB only after a failed POST, the persister's flush and the
// queue write — a reload inside that window came back with the old count and an empty outbox.
// The "reload" is the IndexedDB fake's `reloaded()`: only transactions that completed survive it.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { pageHarness, resetPage } from './hooks-fixture';
import { fakeIndexedDb } from './idb-fake-fixture';
import { openLocalStore, scopeKey } from './local-store-idb';
import { OUTBOX_KEY, type OutboxHandle } from './outbox-slot';
import { localOutbox } from './page-outbox';
import type { LocalTx } from './record-tx';
import { type MutatorLike, useMutation } from './use-mutation';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'navigator');
  resetPage();
  rescope(null);
});

const LIKE: MutatorLike = {
  name: 'likePost',
  local(tx: LocalTx, input: { readonly postId: string }) {
    tx['posts']?.update(input.postId, (post) =>
      post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
    );
  },
};

const quiet = (): void => undefined;

/** The page as its boot leaves it, over `disk`: a store, and an outbox on IndexedDB. */
async function bootedOver(disk: ReturnType<typeof fakeIndexedDb>) {
  const harness = pageHarness();
  const local = openLocalStore({ indexedDB: disk, warn: quiet });
  const outbox = localOutbox({ local, principal: () => 'kenji', warn: quiet });
  Object.defineProperty(globalThis, OUTBOX_KEY, { value: outbox, configurable: true });
  await outbox.ready;
  harness.page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
  return { ...harness, outbox };
}

/** What a page reloaded over `disk` finds in kenji's outbox. */
async function queuedOn(disk: ReturnType<typeof fakeIndexedDb>): Promise<readonly string[]> {
  const local = await openLocalStore({ indexedDB: disk, warn: quiet });
  const state = await local.queue(scopeKey('kenji') ?? '');
  return (state?.mutations ?? []).filter((m) => m.status === 'pending').map((m) => m.key);
}

describe('a write made while the browser knows it is offline', () => {
  test('is on disk by the time it is on screen: a reload at the first paint keeps it', async () => {
    rescope('kenji');
    const disk = fakeIndexedDb();
    const { page } = await bootedOver(disk);
    Reflect.set(globalThis, 'navigator', { onLine: false });
    const posted: string[] = [];
    // The browser's own refusal, handed to the code under test — an input, never a verdict.
    const unreachable = (url: string): Promise<Response> => {
      posted.push(String(url));
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    globalThis.fetch = unreachable as unknown as typeof fetch;

    // The reload is taken at the FIRST notification that shows the like — the earliest a user, or
    // the e2e's poll, could see it and reload.
    let atPaint: ReturnType<typeof fakeIndexedDb> | undefined;
    page.store.subscribe(() => {
      if (atPaint === undefined && page.store.peek('posts', 'p1')?.['likes'] === 2) {
        atPaint = disk.reloaded();
      }
    });
    expect(await useMutation(LIKE)({ postId: 'p1' })).toBeUndefined();

    if (atPaint === undefined) return expect.unreachable('the like was never painted');
    const kept = await queuedOn(atPaint);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^likePost:/);
    // Known offline, nothing was attempted: the write's one POST is its replay's.
    expect(posted).toEqual([]);
    expect(page.store.pending()).toEqual(kept);
  });

  test('back online, the queued write is sent ONCE, under the key it was queued with', async () => {
    rescope('kenji');
    const disk = fakeIndexedDb();
    const { page, outbox } = await bootedOver(disk);
    const navigator = { onLine: false };
    Reflect.set(globalThis, 'navigator', navigator);
    await useMutation(LIKE)({ postId: 'p1' });
    const [key] = await queuedOn(disk.reloaded());

    navigator.onLine = true;
    const keys: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      return new Response(
        JSON.stringify({ data: null, records: { posts: { p1: { id: 'p1', likes: 2 } } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-ultimate-records': '1' } },
      );
    }) as typeof fetch;
    await outbox.replay();
    await outbox.replay();

    expect(keys).toEqual([key ?? 'missing']);
    expect(await queuedOn(disk.reloaded())).toEqual([]);
    expect(page.store.pending()).toEqual([]);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
  });

  test('an outbox that refuses the write takes nothing onto the screen and rejects the call', async () => {
    rescope('kenji');
    const disk = fakeIndexedDb();
    const { page, outbox } = await bootedOver(disk);
    Reflect.set(globalThis, 'navigator', { onLine: false });
    const painted: number[] = [];
    page.store.subscribe(() => painted.push(Number(page.store.peek('posts', 'p1')?.['likes'])));
    // The principal leaves between the tap and the queue: the write is nobody's to send.
    const mutate = useMutation(LIKE);
    const call = mutate({ postId: 'p1' });
    rescope('someone-else');
    const error = await call.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeUltimateError('X_OFFLINE_QUEUE_ABANDONED');
    expect(painted).not.toContain(2);
    expect(page.store.pending()).toEqual([]);
    expect(outbox.size).toBe(0);
  });

  test('a principal that leaves once the write is queued takes it with them: never painted', async () => {
    rescope('kenji');
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    Reflect.set(globalThis, 'navigator', { onLine: false });
    const handle: OutboxHandle = {
      // The queue took it — and the principal changed before the hook resumed.
      enqueue: async () => {
        rescope('someone-else');
      },
      replay: async () => undefined,
      pending: () => [],
      size: 0,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      ready: Promise.resolve(),
    };
    Object.defineProperty(globalThis, OUTBOX_KEY, { value: handle, configurable: true });
    const painted: number[] = [];
    page.store.subscribe(() => painted.push(Number(page.store.peek('posts', 'p1')?.['likes'])));

    const mutate = useMutation(LIKE);
    const error = await mutate({ postId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeUltimateError('X_OFFLINE_QUEUE_ABANDONED');
    expect(painted).not.toContain(2);
    expect(mutate.pending).toBe(0);
  });
});
