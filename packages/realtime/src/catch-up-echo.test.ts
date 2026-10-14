// A channel's catch-up read that already reflects this page's pending write. The read names no
// write, so its rows alone are truth UNDER the twin — a like counted twice — and the write's own
// echo, held behind the read, is what says otherwise. The read and the frames held behind it are
// therefore ONE notification: no holder ever sees the read's rows with the twin replayed over them.
// Observed as `offline-like.e2e.test.ts`'s "3,3" (CI, 2026-10-07, -09 and -14).

import { afterEach, describe, expect, test } from 'bun:test';
import { writeDigest } from '@ultimat3/core';
import { catchUpRead } from './channel-catch-up';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import type { RecordStore } from './record-store';
import type { LocalTx } from './record-tx';
import { type ChannelRecordsFrame, PROTOCOL_VERSION } from './sync-protocol';
import { useChannel } from './use-channel';
import { type MutatorLike, useMutation } from './use-mutation';

interface Held {
  readonly url: string;
  readonly key: string;
  answer(response: Response): void;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

/** Every request held until the test answers it: "the read answered while the POST was out". */
function heldFetch(): Held[] {
  const held: Held[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      held.push({
        url: String(url),
        key: new Headers(init.headers).get('idempotency-key') ?? '',
        answer: resolve,
      });
    })) as typeof fetch;
  return held;
}

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};

/** The dummy app's twin: convergent over `likedByMe`, a column a channel row never carries. */
const LIKE: MutatorLike = {
  name: 'likePost',
  local(tx: LocalTx, input: { readonly postId: string }) {
    tx['posts']?.update(input.postId, (post) =>
      post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
    );
  },
};

const echo = (write: string): ChannelRecordsFrame => ({
  type: 'records',
  v: PROTOCOL_VERSION,
  channel: 'org-feed.o1',
  seq: 1,
  epoch: 'e2',
  adopt: { posts: { p1: { id: 'p1', likes: 2 } } },
  write,
});

const enveloped = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-ultimate-records': '1' },
  });

/** Every like count a holder of `posts:p1` could have painted, one entry per notification. */
function paints(store: RecordStore): number[] {
  const seen: number[] = [];
  store.subscribe(() => seen.push(Number(store.peek('posts', 'p1')?.['likes'])));
  return seen;
}

describe('a catch-up read that already holds a pending write', () => {
  test('is adopted with the echo held behind it, so the write is never painted twice', async () => {
    const { page, socket } = pageHarness({ catchUp: catchUpRead });
    socket.open();
    useChannel(orgFeed, { orgId: 'o1' });
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const held = heldFetch();
    const seen = paints(page.store);

    const done = useMutation(LIKE)({ postId: 'p1' });
    await flush();
    const post = held.find((request) => request.key !== '');
    if (post === undefined) return expect.unreachable('the like was never sent');
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);

    // The node says the channel moved on without this socket: re-read, holding frames meanwhile.
    socket.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      epoch: 'e2',
    });
    await flush();
    const read = held.find((request) => request.url.includes('/_x/query/'));
    if (read === undefined) return expect.unreachable('the catch-up read was never sent');

    // The write commits, its echo is held behind the read, and the read sees the commit.
    const write = await writeDigest(post.key);
    if (write === undefined) return expect.unreachable('this runtime digests no write');
    socket.deliver(echo(write));
    read.answer(enveloped({ data: [], records: { posts: { p1: { id: 'p1', likes: 2 } } } }));
    await flush();

    expect(seen).not.toContain(3);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(page.store.pending()).toEqual([]);

    post.answer(enveloped({ data: null, records: { posts: { p1: { id: 'p1', likes: 2 } } } }));
    await done;
    expect(seen).not.toContain(3);
    expect(seen.at(-1)).toBe(2);
  });

  test("a read holding only another member's write is truth under the twin, as before", async () => {
    const { page, socket } = pageHarness({ catchUp: catchUpRead });
    socket.open();
    useChannel(orgFeed, { orgId: 'o1' });
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const held = heldFetch();
    void useMutation(LIKE)({ postId: 'p1' });
    await flush();

    socket.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      epoch: 'e2',
    });
    await flush();
    const read = held.find((request) => request.url.includes('/_x/query/'));
    if (read === undefined) return expect.unreachable('the catch-up read was never sent');
    read.answer(enveloped({ data: [], records: { posts: { p1: { id: 'p1', likes: 2 } } } }));
    await flush();

    // Their like (1 → 2) and ours, still pending over it.
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(3);
    expect(page.store.pending()).toHaveLength(1);
  });
});
