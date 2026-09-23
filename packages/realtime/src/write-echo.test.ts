// A `records` frame that names the write that produced it. The node commits, fans the change out and
// only then writes the HTTP answer, so the frame routinely beats the answer — and a frame carrying
// the write's own row, merged under that write's still-pending overlay, painted the write TWICE
// (a like showed 3 for one member's one like) until the answer settled it. A frame naming a
// pending write of this page settles that write in the same notification; any other frame is
// server truth under the overlay, exactly as before.

import { afterEach, describe, expect, test } from 'bun:test';
import { writeDigest } from '@ultimat3/core';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import { pageOutbox } from './page-outbox';
import type { RecordStore } from './record-store';
import type { LocalTx } from './record-tx';
import { type ChannelRecordsFrame, PROTOCOL_VERSION } from './sync-protocol';
import { useChannel } from './use-channel';
import { type MutatorLike, useMutation } from './use-mutation';

interface Held {
  readonly key: string;
  answer(response: Response): void;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

/** A `fetch` the test answers by hand: "the frame arrived before the answer" is then a state. */
function heldFetch(): Held[] {
  const held: Held[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      held.push({ key: new Headers(init.headers).get('idempotency-key') ?? '', answer: resolve });
    })) as typeof fetch;
  return held;
}

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};

/** The dummy app's twin: convergent over `likedByMe`, a column the server's post row never has. */
const LIKE: MutatorLike = {
  name: 'likePost',
  local(tx: LocalTx, input: { readonly postId: string }) {
    tx['posts']?.update(input.postId, (post) =>
      post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
    );
  },
};

function frame(seq: number, likes: number, write?: string): ChannelRecordsFrame {
  return {
    type: 'records',
    v: PROTOCOL_VERSION,
    channel: 'org-feed.o1',
    seq,
    epoch: 'e1',
    adopt: { posts: { p1: { id: 'p1', likes } } },
    ...(write === undefined ? {} : { write }),
  };
}

function answer(likes: number): Response {
  return new Response(
    JSON.stringify({ data: null, records: { posts: { p1: { id: 'p1', likes } } } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ultimate-records': '1' },
    },
  );
}

/** Every like count a holder of `posts:p1` could have painted, one entry per notification. */
function paints(store: RecordStore): number[] {
  const seen: number[] = [];
  store.subscribe(() => seen.push(Number(store.peek('posts', 'p1')?.['likes'])));
  return seen;
}

function seeded() {
  const harness = pageHarness();
  harness.socket.open();
  useChannel(orgFeed, { orgId: 'o1' });
  harness.page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
  return harness;
}

describe('a records frame naming the write that produced it', () => {
  test('useMutation: the echo lands before the answer and the write is never painted twice', async () => {
    const { page, socket } = seeded();
    const held = heldFetch();
    const seen = paints(page.store);
    const done = useMutation(LIKE)({ postId: 'p1' });
    await flush();
    const write = await writeDigest(held[0]?.key ?? '');

    socket.deliver(frame(1, 2, write));
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(page.store.pending()).toEqual([]);

    held[0]?.answer(answer(2));
    await done;
    expect(seen).not.toContain(3);
    expect(seen.at(-1)).toBe(2);
  });

  test('the outbox replay: the echo of a queued write settles it the same way', async () => {
    const { page, socket } = seeded();
    pageOutbox();
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await useMutation(LIKE)({ postId: 'p1' })).toBeUndefined();
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    const held = heldFetch();
    const seen = paints(page.store);
    const replayed = pageOutbox().replay();
    await flush();
    expect(held).toHaveLength(1);
    socket.deliver(frame(1, 2, await writeDigest(held[0]?.key ?? '')));
    expect(page.store.pending()).toEqual([]);

    held[0]?.answer(answer(2));
    await replayed;
    expect(seen).not.toContain(3);
    expect(seen.at(-1)).toBe(2);
    expect(pageOutbox().size).toBe(0);
  });

  test("another member's write during a pending one is truth UNDER the overlay", async () => {
    const { page, socket } = seeded();
    const held = heldFetch();
    const done = useMutation(LIKE)({ postId: 'p1' });
    await flush();

    socket.deliver(frame(1, 2, await writeDigest('likePost:somebody-else')));
    // Their like (1 → 2) and ours, still pending over it.
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(3);
    expect(page.store.pending()).toHaveLength(1);

    held[0]?.answer(answer(3));
    await done;
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(3);
    expect(page.store.pending()).toEqual([]);
  });

  test('a frame naming no write this page knows is a plain merge', async () => {
    const { page, socket } = seeded();
    heldFetch();
    void useMutation(LIKE)({ postId: 'p1' });
    await flush();

    socket.deliver(frame(1, 5));
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(6);
    socket.deliver(frame(2, 7, 'f'.repeat(32)));
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(8);
    expect(page.store.pending()).toHaveLength(1);
  });

  test('a custom policy decides the echo exactly as it decides the answer: twin over NEW truth', async () => {
    const { page, socket } = seeded();
    const held = heldFetch();
    const locals: unknown[] = [];
    const merging: MutatorLike = {
      ...LIKE,
      conflict: {
        kind: 'custom',
        merge: (local, server) => {
          locals.push(local['likes']);
          return server;
        },
      },
    };
    void useMutation(merging)({ postId: 'p1' });
    await flush();

    // Another member's like first: the truth under the twin is now 2.
    socket.deliver(frame(1, 2));
    socket.deliver(frame(2, 4, await writeDigest(held[0]?.key ?? '')));
    // The twin replayed over the echo's truth (4 + 1), never over the truth before it (2 + 1).
    expect(locals).toEqual([5]);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(4);
  });

  test('a write whose answer is still out keeps every row the echo did NOT carry', async () => {
    const { page, socket } = seeded();
    page.store.adopt('authors', { a1: { id: 'a1', likesGiven: 0 } });
    const held = heldFetch();
    const both: MutatorLike = {
      name: 'likePost',
      local(tx: LocalTx) {
        LIKE.local?.(tx, { postId: 'p1' });
        tx['authors']?.update('a1', (author) =>
          author['counted'] === true ? {} : { counted: true, likesGiven: 1 },
        );
      },
    };
    void useMutation(both)({ postId: 'p1' });
    await flush();

    socket.deliver(frame(1, 2, await writeDigest(held[0]?.key ?? '')));
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    // The author row has had no server truth yet: its overlay stays until one arrives.
    expect(page.store.peek('authors', 'a1')?.['likesGiven']).toBe(1);
  });
});
