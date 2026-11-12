// The serial lane per mutator never holds a write off the disk: a POST that hangs (a half-open
// socket) must not keep an offline write out of IndexedDB — a reload would lose it (#777) — nor
// keep an online one waiting forever. Past `LANE_WAIT_MS` the write is the outbox's, in order.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { pageHarness, resetPage } from './hooks-fixture';
import { fakeIndexedDb } from './idb-fake-fixture';
import { openLocalStore, scopeKey } from './local-store-idb';
import { OUTBOX_KEY } from './outbox-slot';
import { localOutbox } from './page-outbox';
import type { LocalTx } from './record-tx';
import { LANE_WAIT_MS, type MutatorLike, useMutation } from './use-mutation';

const realFetch = globalThis.fetch;

/** Microtasks only: the IndexedDB fake commits on them, and a fake clock holds every timer. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
};

/** Each hanging POST's way out: it holds the realm's outbox lock, which outlives a test. */
const hung: ((failure: TypeError) => void)[] = [];

afterEach(async () => {
  // The browser's own refusal, handed to the code under test — an input, never a verdict.
  for (const fail of hung.splice(0)) fail(new TypeError('Failed to fetch'));
  await settle();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'navigator');
  resetPage();
  rescope(null);
});

const TOGGLE: MutatorLike = {
  name: 'likePost',
  local(tx: LocalTx, input: { readonly postId: string; readonly liked: boolean }) {
    tx['posts']?.update(input.postId, () => ({ likedByMe: input.liked }));
  },
};

const quiet = (): void => undefined;

/** A `fetch` that never answers — the half-open socket — recording what was POSTed. */
function hangingFetch(): string[] {
  const bodies: string[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Promise<Response>((_resolve, reject) => {
      hung.push(reject);
    });
  }) as typeof fetch;
  return bodies;
}

async function bootedOver(disk: ReturnType<typeof fakeIndexedDb>) {
  const harness = pageHarness();
  const local = openLocalStore({ indexedDB: disk, warn: quiet });
  const outbox = localOutbox({ local, principal: () => 'kenji', warn: quiet });
  Object.defineProperty(globalThis, OUTBOX_KEY, { value: outbox, configurable: true });
  await outbox.ready;
  harness.page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false } });
  return { ...harness, outbox };
}

/** The keys a page reloaded over `disk` finds pending in kenji's outbox. */
async function queuedOn(disk: ReturnType<typeof fakeIndexedDb>): Promise<readonly string[]> {
  const local = await openLocalStore({ indexedDB: disk, warn: quiet });
  const state = await local.queue(scopeKey('kenji') ?? '');
  return (state?.mutations ?? []).filter((m) => m.status === 'pending').map((m) => m.key);
}

describe('the lane never holds a write off the disk', () => {
  test('an offline write behind a hanging POST is on disk before a reload', async () => {
    rescope('kenji');
    const disk = fakeIndexedDb();
    await bootedOver(disk);
    const posted = hangingFetch();
    const like = useMutation(TOGGLE);
    void like({ postId: 'p1', liked: true });
    await settle();
    expect(posted).toHaveLength(1);

    const navigator = { onLine: false };
    Reflect.set(globalThis, 'navigator', navigator);
    let answered: unknown = 'pending';
    void like({ postId: 'p1', liked: false }).then((output) => {
      answered = output;
    });
    await settle();
    expect(answered).toBeUndefined();
    const kept = await queuedOn(disk.reloaded());
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^likePost:/);
  });

  test('an online write behind a hanging POST goes to the outbox once the bound passes', async () => {
    jest.useFakeTimers();
    rescope('kenji');
    const disk = fakeIndexedDb();
    const { outbox } = await bootedOver(disk);
    const posted = hangingFetch();
    const like = useMutation(TOGGLE);
    void like({ postId: 'p1', liked: true });
    let answered: unknown = 'pending';
    void like({ postId: 'p1', liked: false }).then((output) => {
      answered = output;
    });
    await settle();
    expect(posted).toHaveLength(1);

    jest.advanceTimersByTime(LANE_WAIT_MS - 1);
    await settle();
    expect(answered).toBe('pending');
    expect(outbox.pending()).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await settle();
    expect(answered).toBeUndefined();
    expect(await queuedOn(disk.reloaded())).toHaveLength(1);
    // A third write queues behind it rather than overtaking it over HTTP.
    let third: unknown = 'pending';
    void like({ postId: 'p1', liked: true }).then((output) => {
      third = output;
    });
    await settle();
    expect(third).toBeUndefined();
    expect(outbox.pending()).toHaveLength(2);
    expect(posted.filter((body) => body.includes('"liked":true'))).toHaveLength(1);
  });
});
