// `useQuery`: the one read hook. A non-live ref is one HTTP read whose rows become store records
// — so a later write to one of them re-renders the list with no second request. A live ref
// subscribes over the page socket, and its window renders out of the same store. Both answer
// core's `AsyncState`, and a refetch keeps what is on screen.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Row } from '@ultimat3/core';
import { makeCursor } from './cursor';
import { flush, liveFeed, pageHarness, querySid, resetPage } from './hooks-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';
import { useQuery } from './use-query';

const realFetch = globalThis.fetch;

/**
 * Answers each read with the next body, as the server does for an output of entity rows: the
 * records envelope, `records.posts` keyed by record key in answer order. The keys here are
 * deliberately NOT the row ids, so a window keyed by `row.id` in the browser fails every test.
 */
function answering(...bodies: unknown[]): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const data = bodies.shift() ?? [];
    const rows = (Array.isArray(data) ? data : (data as { rows: Row[] }).rows) as Row[];
    const posts = Object.fromEntries(rows.map((row) => [`k-${String(row['id'])}`, row]));
    return new Response(JSON.stringify({ data, records: { posts } }), {
      status: 200,
      headers: { 'x-ultimate-records': '1' },
    });
  }) as typeof fetch;
  return urls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

describe('useQuery — a non-live read', () => {
  test('pending, then ready with the rows, read from the query route', async () => {
    pageHarness();
    const urls = answering([{ id: 'p1', title: 'a' }]);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, { orgId: 'o1' });
    expect(posts()).toEqual({ status: 'pending' });
    await flush();
    expect(urls).toEqual(['/_x/query/list-posts?orgId=o1']);
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1', title: 'a' }] });
  });

  test('a write to one of its records re-renders the list with no second request', async () => {
    const { page } = pageHarness();
    const urls = answering([{ id: 'p1', likes: 1 }]);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();

    page.store.adopt('posts', { 'k-p1': { id: 'p1', likes: 7 } });
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1', likes: 7 }] });
    expect(urls).toHaveLength(1);
  });

  test('a record the server removed drops out of the list', async () => {
    const { page } = pageHarness();
    answering([{ id: 'p1' }, { id: 'p2' }]);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    page.store.remove('posts', ['k-p1']);
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p2' }] });
  });

  test('a refetch keeps the previous rows on screen as refreshing', async () => {
    pageHarness();
    answering([{ id: 'p1' }], [{ id: 'p2' }]);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    posts.refetch();
    expect(posts()).toEqual({ status: 'refreshing', data: [{ id: 'p1' }] });
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p2' }] });
  });

  test('a failed read is `failed` with the error, never an empty list', async () => {
    pageHarness();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'X_FORBIDDEN', cause: 'no', fix: 'x policy explain' }), {
        status: 403,
      })) as unknown as typeof fetch;
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(posts().status).toBe('failed');
  });

  test('releasing lets go of its records', async () => {
    const { page } = pageHarness();
    answering([{ id: 'p1' }]);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(page.store.peek('posts', 'k-p1')).toBeDefined();
    posts.release();
    expect(page.store.peek('posts', 'k-p1')).toBeUndefined();
  });
});

describe('useQuery — an answer with no records envelope', () => {
  test('holds its own rows: they are not records, and no key is derived for them', async () => {
    const { page } = pageHarness();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 'p1', title: 'a' }]), {
        status: 200,
      })) as unknown as typeof fetch;
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1', title: 'a' }] });
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });
});

describe('useQuery — a live read', () => {
  test('subscribes over the page socket; a snapshot is ready, a patch moves it', () => {
    const { socket, clock } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, { orgId: 'o1' });
    expect(feed()).toEqual({ status: 'pending' });
    const sid = querySid(socket, 'add');
    const rows = [{ id: 'p1', likes: 1 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', '0'.repeat(24), rows, clock.now().getTime()),
    });
    expect(feed()).toEqual({ status: 'ready', data: [{ id: 'p1', likes: 1 }] });

    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: '1'.repeat(24),
      patches: [{ op: 'update', id: 'p1', row: { likes: 2 }, lsn: '1'.repeat(24) }],
    });
    expect(feed()).toEqual({ status: 'ready', data: [{ id: 'p1', likes: 2 }] });
  });

  test('its rows ARE the store records: an HTTP answer about one re-renders the live list', () => {
    const { socket, page, clock } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, null);
    const rows = [{ id: 'p1', likes: 1 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: querySid(socket, 'add'),
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', '0'.repeat(24), rows, clock.now().getTime()),
    });
    page.store.adopt('posts', { p1: { id: 'p1', likes: 5 } });
    expect(feed()).toEqual({ status: 'ready', data: [{ id: 'p1', likes: 5 }] });
  });

  test('a dropped socket keeps what was shown, busy', () => {
    const { socket, clock } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, null);
    const sid = querySid(socket, 'add');
    const rows = [{ id: 'p1' }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', '0'.repeat(24), rows, clock.now().getTime()),
    });
    socket.close(1006);
    expect(feed()).toEqual({ status: 'refreshing', data: [{ id: 'p1' }] });
  });

  test("a refused subscription is failed, with the node's own error", () => {
    const { socket } = pageHarness();
    socket.open();
    const denied = { code: 'X_FORBIDDEN', cause: 'no', fix: 'x policy explain --json' };
    const feed = useQuery(liveFeed, null);
    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: querySid(socket, 'add'),
      lsn: null,
      error: denied,
    });
    expect(feed()).toEqual({ status: 'failed', error: denied });
  });

  test('on a server render it is pending and opens nothing', () => {
    resetPage();
    expect(useQuery(liveFeed, null)()).toEqual({ status: 'pending' });
  });
});

describe('useQuery — paged', () => {
  test('first page, then more() appends from the server cursor; hasMore follows the answer', async () => {
    pageHarness();
    const urls = answering(
      { rows: [{ id: 'p1' }, { id: 'p2' }], endCursor: 'c2', hasNextPage: true },
      { rows: [{ id: 'p3' }], endCursor: 'c3', hasNextPage: false },
    );
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null, { first: 2 });
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1' }, { id: 'p2' }] });
    expect(posts.hasMore()).toBe(true);

    posts.more();
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] });
    expect(posts.hasMore()).toBe(false);
    expect(urls[1]).toContain('c2');
    posts.more(); // no next page: nothing is read
    await flush();
    expect(urls).toHaveLength(2);
  });

  // A `more()` a refetch superseded still wrote its page's cursor, before the generation check that
  // discards its rows — so the refetched first page came back with `hasMore` and a cursor from a
  // page nobody is showing, and the next `more()` skipped the second page.
  test('a superseded more() leaves the cursor to the read that replaced it', async () => {
    pageHarness();
    const bodies: unknown[] = [{ rows: [{ id: 'p1' }], endCursor: 'c1', hasNextPage: true }];
    const held: ((body: unknown) => void)[] = [];
    const urls: string[] = [];
    globalThis.fetch = ((url: string) => {
      urls.push(url);
      const answer = (data: unknown): Response => {
        const rows = (data as { rows: Row[] }).rows;
        const posts = Object.fromEntries(rows.map((row) => [`k-${String(row['id'])}`, row]));
        return new Response(JSON.stringify({ data, records: { posts } }), {
          status: 200,
          headers: { 'x-ultimate-records': '1' },
        });
      };
      const next = bodies.shift();
      if (next !== undefined) return Promise.resolve(answer(next));
      return new Promise<Response>((resolve) => held.push((body) => resolve(answer(body))));
    }) as typeof fetch;
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null, { first: 1 });
    await flush();
    posts.more(); // held: the page after c1
    posts.refetch(); // held: a fresh first page
    // The refetch answers first; the stale more() answers last.
    held[1]?.({ rows: [{ id: 'p1' }], endCursor: 'fresh', hasNextPage: true });
    await flush();
    held[0]?.({ rows: [{ id: 'p2' }], endCursor: 'stale', hasNextPage: false });
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 'p1' }] });
    expect(posts.hasMore()).toBe(true);
    posts.more();
    await flush();
    expect(urls.at(-1)).toContain('fresh');
  });
});
