// `useMutation`: the one write path. The optimistic twin is visible in every holder before the
// call returns; the action is POSTed over HTTP with an idempotency key; the answer's records land
// before the overlay goes (no flicker); a refusal takes the overlay back and surfaces the code; and
// the socket carries nothing at all.

import { afterEach, describe, expect, test } from 'bun:test';
import { type ConflictPolicy, type Row, rescope, UltimateError } from '@ultimat3/core';
import { type FakeSocket, pageHarness, resetPage } from './hooks-fixture';
import { pageOutbox } from './page-outbox';
import type { LocalTx } from './record-tx';
import { type MutatorLike, useMutation, useMutationQueue } from './use-mutation';
import { useRecord } from './use-record';

interface Pending {
  readonly url: string;
  readonly init: RequestInit;
  answer(response: Response): void;
}

/** A `fetch` the test answers by hand, so "before the server answered" is a state it can assert. */
function heldFetch(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({ url, init, answer: resolve });
    })) as typeof fetch;
  return pending;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

/** Convergent, as every twin must be: replayed over its own result it changes nothing. */
function likePost(conflict?: ConflictPolicy): MutatorLike {
  return {
    name: 'likePost',
    ...(conflict === undefined ? {} : { conflict }),
    local(tx: LocalTx, input: { readonly postId: string }) {
      tx['posts']?.update(input.postId, (post) =>
        post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
      );
    },
  };
}

function recordsAnswer(data: unknown, posts: Record<string, Row>): Response {
  return new Response(JSON.stringify({ data, records: { posts } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-ultimate-records': '1' },
  });
}

function frameTypes(socket: FakeSocket): readonly string[] {
  return socket.frames().map((frame) => frame.type);
}

describe('useMutation', () => {
  test('the overlay is visible in every holder before the server answers', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    const a = useRecord('posts', 'p1');
    const b = useRecord('posts', 'p1');
    const like = useMutation(likePost());

    const done = like({ postId: 'p1' });
    expect(a()).toEqual({ status: 'ready', data: { id: 'p1', likedByMe: true, likes: 2 } });
    expect(b()).toEqual(a());
    expect(like.pending).toBe(1);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    requests[0]?.answer(
      recordsAnswer({ ok: true }, { p1: { id: 'p1', likedByMe: true, likes: 2 } }),
    );
    await done;
    expect(like.pending).toBe(0);
    expect(page.store.pending()).toEqual([]);
  });

  test('POSTs the action route with the input and an idempotency key — never a socket frame', async () => {
    const { socket } = pageHarness();
    socket.open();
    const before = frameTypes(socket);
    const requests = heldFetch();
    const like = useMutation(likePost());

    const done = like({ postId: 'p1' });
    const sent = requests[0];
    expect(sent?.url).toBe('/api/posts/like');
    expect(sent?.init.method).toBe('POST');
    expect(sent?.init.body).toBe(JSON.stringify({ postId: 'p1' }));
    const headers = new Headers(sent?.init.headers);
    expect(headers.get('idempotency-key')).toMatch(/^likePost:/);

    sent?.answer(new Response(JSON.stringify({ liked: true }), { status: 200 }));
    expect(await done).toEqual({ liked: true });
    expect(frameTypes(socket)).toEqual(before);
  });

  test('the answer lands before the overlay goes: no render ever shows the pre-write value', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    const post = useRecord('posts', 'p1');
    const like = useMutation(likePost());
    const done = like({ postId: 'p1' });

    const shown: unknown[] = [];
    page.store.subscribe(() => {
      const state = post();
      shown.push(state.status === 'ready' ? state.data?.['likes'] : state.status);
    });
    requests[0]?.answer(recordsAnswer(null, { p1: { id: 'p1', likedByMe: true, likes: 2 } }));
    await done;

    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((likes) => likes === 2)).toBe(true);
  });

  test('a refusal rolls the overlay back and surfaces the registered code', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    const like = useMutation(likePost());
    const queue = useMutationQueue();

    const done = like({ postId: 'p1' });
    requests[0]?.answer(
      new Response(
        JSON.stringify({ code: 'X_FORBIDDEN', cause: 'not a member', fix: 'x policy explain' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    const error = await done.then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error instanceof UltimateError && error.code).toBe('X_FORBIDDEN');
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', likedByMe: false, likes: 1 });
    expect(queue.pending).toBe(0);
    expect(queue.failed).toBe(1);
  });

  test('two pending writes on one row replay in order over a server update', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const bump = useMutation({
      name: 'bumpPost',
      local(tx: LocalTx) {
        tx['posts']?.update('p1', (post) => ({ likes: Number(post['likes']) + 10 }));
      },
    });
    const first = bump(null);
    const second = bump(null);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(21);

    // Somebody else's write reaches this page (a frame, another answer): both overlays ride on it.
    page.store.merge('posts', 'p1', { likes: 100 });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(120);

    requests[0]?.answer(recordsAnswer(null, { p1: { id: 'p1', likes: 110 } }));
    await first;
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(120);
    requests[1]?.answer(recordsAnswer(null, { p1: { id: 'p1', likes: 120 } }));
    await second;
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(120);
    expect(page.store.pending()).toEqual([]);
  });

  test('a custom conflict policy declared on the mutator is CALLED when the answer lands', async () => {
    const { page } = pageHarness();
    const requests = heldFetch();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    const calls: [Row, Row][] = [];
    const like = useMutation(
      likePost({
        kind: 'custom',
        merge: (local, server) => {
          calls.push([local, server]);
          return { ...server, likedByMe: local['likedByMe'] };
        },
      }),
    );
    const done = like({ postId: 'p1' });
    requests[0]?.answer(recordsAnswer(null, { p1: { id: 'p1', likedByMe: false, likes: 9 } }));
    await done;

    expect(calls).toEqual([
      [
        { id: 'p1', likedByMe: true, likes: 10 },
        { id: 'p1', likedByMe: false, likes: 9 },
      ],
    ]);
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', likedByMe: true, likes: 9 });
  });

  test('on a server render a call is X_LIVE_SERVER_RENDER and the counts read zero', async () => {
    resetPage();
    const like = useMutation(likePost());
    expect(like.pending).toBe(0);
    expect(useMutationQueue().pending).toBe(0);
    const error = await like({ postId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof UltimateError && error.code).toBe('X_LIVE_SERVER_RENDER');
    // The fix is the island, never `hasPageSocket()`: that answers false on the server forever,
    // and the `budgets` step reports a guarded call as X_LIVE_ROUTE_NO_ISLAND.
    const fix = error instanceof UltimateError ? error.fix : '';
    expect(fix).toContain('x g island <route-dir> --at <route-dir>');
    expect(fix).not.toContain('hasPageSocket');
  });
});

describe('releasing a write hook', () => {
  test('takes its listener off the page — the counts outlive every component', () => {
    const { page } = pageHarness();
    const before = page.writes.listeners.size;
    const like = useMutation(likePost());
    const queue = useMutationQueue();
    expect(page.writes.listeners.size).toBe(before + 2);
    like.release();
    queue[Symbol.dispose]();
    expect(page.writes.listeners.size).toBe(before);
  });
});

describe('a write the network refused', () => {
  test('goes to the outbox with its overlay kept, and is replayed ONCE, under its own key', async () => {
    const { page } = pageHarness();
    pageOutbox(); // what the page boot does: the one module that opens the outbox
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const like = useMutation(likePost());

    expect(await like({ postId: 'p1' })).toBeUndefined();
    // Still shown: the intent is the outbox's now, not a failure to take back.
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    const outbox = pageOutbox();
    await outbox.ready;
    expect(outbox.size).toBe(1);
    expect(useMutationQueue().failed).toBe(0);

    const keys: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      return recordsAnswer(null, { p1: { id: 'p1', likedByMe: true, likes: 2 } });
    }) as typeof fetch;
    await outbox.replay();
    await outbox.replay();

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^likePost:/);
    expect(outbox.size).toBe(0);
    expect(page.store.pending()).toEqual([]);
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', likedByMe: true, likes: 2 });
  });

  // No boot ran (a page with no scope tag persists nothing), so there is no outbox to promise the
  // write to: it is refused like any other, never parked in a queue a reload would silently lose.
  test('on a page with no boot it is refused: rejected, overlay taken back, counted failed', async () => {
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const error = await useMutation(likePost())({ postId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof UltimateError && error.meta?.['failure']).toBe('network');
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(useMutationQueue().failed).toBe(1);
    expect(Reflect.has(globalThis, Symbol.for('ultimate.outbox'))).toBe(false);
  });
});

describe('a transport failure that is not the network', () => {
  test('a status failure is a refusal: rejected, overlay dropped, nothing queued', async () => {
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    globalThis.fetch = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const like = useMutation(likePost());
    const error = await like({ postId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof UltimateError).toBe(true);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    const outbox = pageOutbox();
    await outbox.ready;
    expect(outbox.size).toBe(0);
  });

  test('a 2xx that is not JSON may have landed: rejected, NOT queued, overlay kept until the server row', async () => {
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    globalThis.fetch = (async () =>
      new Response('<html>a proxy answered</html>', { status: 200 })) as unknown as typeof fetch;
    const like = useMutation(likePost());
    const error = await like({ postId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof UltimateError && error.meta?.['failure']).toBe('body');
    const outbox = pageOutbox();
    await outbox.ready;
    expect(outbox.size).toBe(0);
    // Still shown: the write may have landed, and taking it back would flash the old value.
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    // The next server row for it decides — here, the write had NOT landed.
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    expect(page.store.pending()).toEqual([]);
  });
});

describe('an action that answers a view, not the entity', () => {
  test('keeps the optimistic row after success until the server row reaches it — the count never flickers back', async () => {
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    // What the dummy's likePost answers: a PostView, no record envelope for `posts`.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ postId: 'p1', likeCount: 2 }), {
        status: 200,
      })) as unknown as typeof fetch;
    const like = useMutation(likePost());
    await like({ postId: 'p1' });
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    // The live frame with the server's row lands; the overlay yields to it.
    page.store.merge('posts', 'p1', { likedByMe: true, likes: 2 });
    expect(page.store.pending()).toEqual([]);
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', likedByMe: true, likes: 2 });
  });
});

describe('a write queued offline, after a reload', () => {
  test('its overlay is rebuilt on mount — the like stays shown — and the replay settles it once', async () => {
    // The first load: the network refuses, the write is queued, the overlay is shown.
    rescope('kenji');
    const first = pageHarness();
    pageOutbox(); // the first load's boot
    first.page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await useMutation(likePost())({ postId: 'p1' });
    expect(first.page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    // The reload: a NEW page (store, outbox), the same disk; the server's row is the old count.
    resetPage();
    const second = pageHarness();
    pageOutbox(); // the reload's boot, which reopens the same disk
    second.page.store.adopt('posts', { p1: { id: 'p1', likedByMe: false, likes: 1 } });
    useMutation(likePost());
    await pageOutbox().ready;
    await Promise.resolve();
    await Promise.resolve();
    expect(second.page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(second.page.store.pending()).toHaveLength(1);

    // Back online: the replay sends it once, under its original key, and settles the overlay.
    const keys: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      return recordsAnswer(null, { p1: { id: 'p1', likedByMe: true, likes: 2 } });
    }) as typeof fetch;
    await pageOutbox().replay();
    await pageOutbox().replay();
    expect(keys).toHaveLength(1);
    expect(second.page.store.pending()).toEqual([]);
    expect(second.page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    rescope(null);
  });
});
