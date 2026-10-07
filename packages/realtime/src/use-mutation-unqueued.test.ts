// `useMutation` when the OUTBOX refuses the write — its queue's principal left
// (`X_OFFLINE_QUEUE_ABANDONED`) or the disk refused it. The caller is told, by code, and the
// optimistic twin is taken back: a write nothing will ever send must not stay painted.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { pageHarness, resetPage } from './hooks-fixture';
import { OUTBOX_KEY, type OutboxEntry, type OutboxHandle } from './outbox-slot';
import { OfflineQueueAbandonedError } from './page-errors';
import type { LocalTx } from './record-tx';
import { type MutatorLike, useMutation, useMutationQueue } from './use-mutation';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, OUTBOX_KEY);
  resetPage();
});

const likePost: MutatorLike = {
  name: 'likePost',
  local(tx: LocalTx, input: { readonly postId: string }) {
    tx['posts']?.update(input.postId, (post) => ({ likes: Number(post['likes']) + 1 }));
  },
};

/** The outbox the boot opened, standing in: `held` are writes already waiting in it. */
function outbox(
  held: readonly OutboxEntry[],
  refusal: (entry: OutboxEntry) => unknown = (entry) =>
    new OfflineQueueAbandonedError({ name: entry.name }),
): OutboxHandle & { readonly asked: OutboxEntry[] } {
  const asked: OutboxEntry[] = [];
  const handle = {
    asked,
    enqueue: async (entry: OutboxEntry) => {
      asked.push(entry);
      throw refusal(entry);
    },
    replay: async () => undefined,
    pending: () => held,
    size: held.length,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    ready: Promise.resolve(),
  };
  Object.defineProperty(globalThis, OUTBOX_KEY, { value: handle, configurable: true });
  return handle;
}

const offline = (): void => {
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
};

describe('a write the outbox refuses', () => {
  test('after the network took nothing: mutate REJECTS with the code and the twin is taken back', async () => {
    const { page } = pageHarness();
    outbox([]);
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    offline();
    const like = useMutation(likePost);
    const queue = useMutationQueue();

    await expect(like({ postId: 'p1' })).rejects.toMatchObject({
      code: 'X_OFFLINE_QUEUE_ABANDONED',
    });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    // A principal change is nobody's failure to report: the next principal's page counts none.
    expect(queue.failed).toBe(0);
    expect(like.pending).toBe(0);
  });

  test('behind older queued writes: the same refusal, the same take-back', async () => {
    const { page } = pageHarness();
    outbox([{ key: 'likePost:older', name: 'unlikePost', input: { postId: 'p9' } }]);
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const like = useMutation(likePost);
    const queue = useMutationQueue();

    await expect(like({ postId: 'p1' })).rejects.toMatchObject({
      code: 'X_OFFLINE_QUEUE_ABANDONED',
    });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(queue.failed).toBe(0);
    expect(like.pending).toBe(0);
  });

  test("a DISK that would not take the write is this page's failure: counted, and told", async () => {
    const { page } = pageHarness();
    outbox([], () => new DOMException('quota', 'QuotaExceededError'));
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    offline();
    const like = useMutation(likePost);
    const queue = useMutationQueue();

    await expect(like({ postId: 'p1' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(queue.failed).toBe(1);
  });
});

// The hook's own await: the POST. A write issued under one principal whose request the network
// drops AFTER the principal changed must not be handed to the outbox at all — by then the outbox
// is the next principal's, and it would be queued, and sent, as them.
describe('a write whose request fails after the principal changed', () => {
  test('is refused by name and never reaches the outbox', async () => {
    rescope('u1');
    pageHarness();
    const next = outbox([], () => expect.unreachable('the outbox was asked'));
    let drop: (error: unknown) => void = () => undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((_resolve, reject) => {
        drop = reject;
      })) as unknown as typeof fetch;
    const like = useMutation(likePost);
    const queue = useMutationQueue();

    const write = like({ postId: 'p1' }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    rescope('u2');
    drop(new TypeError('Failed to fetch'));

    expect(await write).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    expect(next.asked).toEqual([]);
    expect(queue.failed).toBe(0);
    expect(like.pending).toBe(0);
  });
});
