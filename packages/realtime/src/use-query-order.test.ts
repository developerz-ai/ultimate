// A non-live read's list order is the ANSWER's, never a JS object's key order: an object enumerates
// integer-like keys ascending (`JSON.parse` included), so an `integer()` keyed newest-first feed
// keyed its list by `records[type]` alone rendered oldest-first. The envelope's `order` carries it.

import { afterEach, describe, expect, test } from 'bun:test';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import { useQuery } from './use-query';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

const NEWEST_FIRST = [{ id: 30 }, { id: 4 }, { id: 100 }];

/** The server's answer for integer-keyed rows: `records.posts` keyed by `String(id)`. */
function answering(order: readonly string[] | undefined): void {
  const posts = Object.fromEntries(NEWEST_FIRST.map((row) => [String(row.id), row]));
  const body = {
    data: NEWEST_FIRST,
    records: { posts },
    ...(order ? { order: { posts: order } } : {}),
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'x-ultimate-records': '1' },
    })) as unknown as typeof fetch;
}

describe('useQuery — record order', () => {
  test("integer-like keys keep the answer's order when the envelope names it", async () => {
    pageHarness();
    answering(['30', '4', '100']);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: NEWEST_FIRST });
  });

  test('an envelope with no order falls back to the records key order, as before', async () => {
    pageHarness();
    answering(undefined);
    const posts = useQuery({ name: 'listPosts', entity: 'posts' }, null);
    await flush();
    expect(posts()).toEqual({ status: 'ready', data: [{ id: 4 }, { id: 30 }, { id: 100 }] });
  });
});
