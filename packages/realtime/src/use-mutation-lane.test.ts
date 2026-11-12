// Online writes of ONE mutator are sent in call order: a like then an unlike made while the like
// is still in flight must not reach the server concurrently, or they commit in either order and the
// final row contradicts the last overlay the user saw. Another mutator's writes do not wait.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import type { LocalTx } from './record-tx';
import { type MutatorLike, useMutation } from './use-mutation';

interface Pending {
  readonly url: string;
  readonly body: unknown;
  answer(response: Response): void;
}

/** A `fetch` the test answers by hand, so "the second POST has not been sent" is assertable. */
function heldFetch(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({ url, body: init.body, answer: resolve });
    })) as typeof fetch;
  return pending;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

const toggle = (name: string): MutatorLike => ({
  name,
  local(tx: LocalTx, input: { readonly postId: string; readonly liked: boolean }) {
    tx['posts']?.update(input.postId, () => ({ likedByMe: input.liked }));
  },
});

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const refused = (): Response =>
  new Response(JSON.stringify({ code: 'X_TEST_REFUSED', message: 'no', fix: 'none' }), {
    status: 409,
  });

describe('one serial lane per mutator name', () => {
  test('two calls of one mutator: the second POST is not sent until the first settles', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false } });
    const like = useMutation(toggle('likePost'));

    const first = like({ postId: 'p1', liked: true });
    const second = like({ postId: 'p1', liked: false });
    // Both overlays paint at once — the lane orders the network, never the screen.
    expect(page.store.peek('posts', 'p1')?.['likedByMe']).toBe(false);
    expect(like.pending).toBe(2);
    await flush();
    expect(requests.length).toBe(1);
    expect(requests[0]?.body).toBe(JSON.stringify({ postId: 'p1', liked: true }));

    requests[0]?.answer(ok());
    await first;
    await flush();
    expect(requests.length).toBe(2);
    expect(requests[1]?.body).toBe(JSON.stringify({ postId: 'p1', liked: false }));
    requests[1]?.answer(ok());
    await second;
    expect(like.pending).toBe(0);
  });

  test('a refused first write still opens the lane for the next', async () => {
    pageHarness();
    const requests = heldFetch();
    const like = useMutation(toggle('likePost'));

    const first = like({ postId: 'p1', liked: true }).catch((error: unknown) => error);
    const second = like({ postId: 'p1', liked: false });
    await flush();
    expect(requests.length).toBe(1);
    requests[0]?.answer(refused());
    await first;
    await flush();
    expect(requests.length).toBe(2);
    requests[1]?.answer(ok());
    expect(await second).toEqual({ ok: true });
  });

  test('two hooks of one mutator share the lane: the page orders the name, not the hook', async () => {
    pageHarness();
    const requests = heldFetch();
    const a = useMutation(toggle('likePost'));
    const b = useMutation(toggle('likePost'));

    const first = a({ postId: 'p1', liked: true });
    const second = b({ postId: 'p1', liked: false });
    await flush();
    expect(requests.length).toBe(1);
    requests[0]?.answer(ok());
    await first;
    await flush();
    requests[1]?.answer(ok());
    await second;
  });

  test('a principal that left while a write waited: that write is refused, never sent as them', async () => {
    rescope('u1');
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false } });
    const like = useMutation(toggle('likePost'));

    const first = like({ postId: 'p1', liked: true });
    const second = like({ postId: 'p1', liked: false }).catch((error: unknown) => error);
    rescope('u2');
    requests[0]?.answer(ok());
    await first.catch(() => undefined);
    await flush();
    expect(requests.length).toBe(1);
    expect(await second).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    expect(like.pending).toBe(0);
  });

  test('another mutator does not wait in this one’s lane', async () => {
    pageHarness();
    const requests = heldFetch();
    const like = useMutation(toggle('likePost'));
    const pin = useMutation(toggle('pinPost'));

    const first = like({ postId: 'p1', liked: true });
    const other = pin({ postId: 'p1', liked: true });
    await flush();
    expect(requests.length).toBe(2);
    for (const request of requests) request.answer(ok());
    await Promise.all([first, other]);
  });
});
