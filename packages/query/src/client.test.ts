/**
 * unit — no server, no socket. The fetch is injected, so what is pinned here is the URL the
 * client derives, the headers it sends and the property names the proxy may answer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { RecordEnvelope, RecordRows, RecordSink } from '@ultimat3/core';
import { createClientFlight, pageClient, RECORDS_HEADER } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { type FetchLike, queryClient, queryClientMethodFor } from './client';
import { query } from './query';
import { from } from './source';

const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

type PostRow = { readonly id: string; readonly title: string };

const publicPost = query({
  input: t.object({ slug: t.string }),
  policy: can('post:read'),
  sql: ({ slug }) =>
    from<PostRow>('posts', async () => [{ id: ORG_ID, title: slug }])
      .where({ slug })
      .orderBy('id')
      .limit(1),
}).named('publicPost');

const queries = { publicPost };

/** One round trip against a fake fetch, answering `rows` and recording what was sent. */
function recorder(rows: readonly PostRow[] = []): {
  readonly fetch: FetchLike;
  readonly seen: { url: string | null; init: RequestInit | null };
} {
  const seen: { url: string | null; init: RequestInit | null } = { url: null, init: null };
  return {
    seen,
    fetch: async (url, init) => {
      seen.url = url;
      seen.init = init;
      return Response.json(rows);
    },
  };
}

describe('the map-wide read client', () => {
  test('derives the route the server mounts, and hands back the rows', async () => {
    const { fetch, seen } = recorder([{ id: ORG_ID, title: 'hello' }]);
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test/', fetch });

    const rows = await client.publicPost({ slug: 'hello' });

    expect(seen.url).toBe('https://app.test/_x/query/public-post?slug=hello');
    expect(seen.init?.method).toBe('GET');
    expect(rows).toEqual([{ id: ORG_ID, title: 'hello' }]);
  });

  test('the map-wide spelling and `.client()` derive the same URL', async () => {
    // One implementation underneath both, so a read cannot be addressed two ways. Nothing else
    // holds this: the map client could have built its own path from the property name.
    const viaMap = recorder();
    const viaQuery = recorder();

    await queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: viaMap.fetch,
    }).publicPost({ slug: 'hello' });
    await publicPost.client({ baseUrl: 'https://app.test', fetch: viaQuery.fetch })({
      slug: 'hello',
    });

    expect(viaMap.seen.url).toBe(viaQuery.seen.url);
  });

  test('an empty input sends no search string at all', async () => {
    const { fetch, seen } = recorder();
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch });

    await client.publicPost({ slug: '' });
    expect(seen.url).toBe('https://app.test/_x/query/public-post?slug=');

    await queryClientMethodFor('publicPostSlugs', { baseUrl: 'https://app.test', fetch })({});
    expect(seen.url).toBe('https://app.test/_x/query/public-post-slugs');
  });

  test('keys are sorted and repeated, so one input is one URL', async () => {
    const { fetch, seen } = recorder();
    const read = queryClientMethodFor('feed', { baseUrl: 'https://app.test', fetch });

    await read({ orgId: ORG_ID, limit: 20, tags: ['a', 'b'], cursor: null, after: undefined });

    // `cursor: null` and `after: undefined` carry no value a schema could read, so they are not
    // sent — an absent key and an empty one are different inputs, and this URL is a cache key.
    expect(seen.url).toBe(`https://app.test/_x/query/feed?limit=20&orgId=${ORG_ID}&tags=a&tags=b`);
  });

  test('a failing read raises the server code, with the server fix line', async () => {
    const fetchStub: FetchLike = async () =>
      Response.json(
        {
          code: 'X_INPUT_INVALID',
          cause: 'slug is required',
          fix: 'x queries describe publicPost',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch: fetchStub });

    const error = await client.publicPost({ slug: 'hello' }).catch((caught: unknown) => caught);

    expect(error).toBeUltimateError('X_INPUT_INVALID');
    expect((error as { fix: string }).fix).toBe('x queries describe publicPost');
  });

  test('a proxy answering HTML is still a typed failure naming the read', async () => {
    const fetchStub: FetchLike = async () => new Response('<html>502</html>', { status: 502 });
    const read = queryClientMethodFor('publicPost', {
      baseUrl: 'https://app.test',
      fetch: fetchStub,
    });

    const error = await read({ slug: 'hello' }).catch((caught: unknown) => caught);

    // Core's transport decodes every client failure one way; the read is named by its URL.
    expect(error).toBeUltimateError('X_CLIENT_TRANSPORT_FAILED');
    expect((error as { cause: string }).cause).toContain('/_x/query/public-post');
    expect((error as { cause: string }).cause).toContain('HTTP 502');
  });

  test('headers and an abort signal reach the wire', async () => {
    const controller = new AbortController();
    const seen: {
      headers: Headers;
      abortedBefore?: boolean | undefined;
      abortedAfter?: boolean | undefined;
    } = {
      headers: new Headers(),
    };
    // Observed WHILE in flight: the transport hands the wire its own signal — the principal fence
    // aborts it too — and forwards the caller's abort into it until the dispatch settles.
    const fetch: FetchLike = async (_url, init) => {
      seen.headers = new Headers(init.headers);
      seen.abortedBefore = init.signal?.aborted;
      controller.abort();
      seen.abortedAfter = init.signal?.aborted;
      return Response.json([]);
    };
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch,
      headers: { 'accept-language': 'es' },
    });

    await client.publicPost({ slug: 'hello' }, { signal: controller.signal });

    expect(seen.headers.get('accept-language')).toBe('es');
    expect(seen.headers.get('accept')).toBe('application/json');
    expect(seen.abortedBefore).toBe(false);
    expect(seen.abortedAfter).toBe(true);
  });

  test('a symbol property is undefined, so the client is not mistaken for a thenable', async () => {
    // `await client` would otherwise read `then` off the proxy and call a read named "then".
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test' });
    const asRecord = client as unknown as Record<symbol, unknown>;

    expect(asRecord[Symbol.toPrimitive]).toBeUndefined();
    expect(asRecord[Symbol.iterator]).toBeUndefined();
  });

  test('`then` is undefined, so awaiting the client resolves to the client', async () => {
    // The symbols above never covered this: `then` is a plain string key, so the proxy answered
    // it with a read method and `await client` fetched `/_x/query/then` instead of resolving.
    let called = 0;
    const fetch: FetchLike = () => {
      called += 1;
      return Promise.resolve(new Response('[]', { status: 200 }));
    };
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch });

    expect((client as unknown as Record<string, unknown>)['then']).toBeUndefined();
    expect(await client).toBe(client);
    expect(await Promise.resolve(client)).toBe(client);
    expect(called).toBe(0);
  });
});

describe('the page half of the read client', () => {
  test('.page() appends the two controls after the sorted input, in a fixed order', async () => {
    const { fetch, seen } = recorder();
    const method = queryClientMethodFor<typeof publicPost.input, PostRow>('publicPost', {
      baseUrl: 'http://dev.test',
      fetch,
    });
    await method.page({ slug: 'hello' }, { first: 20, after: 'c1' });
    expect(seen.url).toBe('http://dev.test/_x/query/public-post?slug=hello&_first=20&_after=c1');
  });

  test('without a cursor only `_first` is sent, and the plain call sends neither', async () => {
    const { fetch, seen } = recorder();
    const method = queryClientMethodFor<typeof publicPost.input, PostRow>('publicPost', {
      baseUrl: 'http://dev.test',
      fetch,
    });
    await method.page({ slug: 'hello' }, { first: 5 });
    expect(seen.url).toBe('http://dev.test/_x/query/public-post?slug=hello&_first=5');
    await method({ slug: 'hello' });
    expect(seen.url).toBe('http://dev.test/_x/query/public-post?slug=hello');
  });

  test('the map-wide client hands out the same .page()', async () => {
    const { fetch, seen } = recorder();
    const client = queryClient<typeof queries>({ baseUrl: 'http://dev.test', fetch });
    await client.publicPost.page({ slug: 'x' }, { first: 1 });
    expect(seen.url).toBe('http://dev.test/_x/query/public-post?slug=x&_first=1');
  });
});

describe('the read client on the page store', () => {
  afterEach(() => {
    pageClient().store = undefined;
  });

  function fakeSink(): { readonly sink: RecordSink; readonly adopted: [string, RecordRows][] } {
    const adopted: [string, RecordRows][] = [];
    return {
      adopted,
      sink: {
        adopt: (type, rows) => {
          adopted.push([type, rows]);
        },
        remove: () => undefined,
      },
    };
  }

  test('an envelope adopts its records into the installed store and returns only data', async () => {
    const row = { id: ORG_ID, title: 'hello' };
    const { sink, adopted } = fakeSink();
    pageClient().store = sink;
    const fetch: FetchLike = async () =>
      Response.json(
        { data: [row], records: { post: { [ORG_ID]: row } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      );
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch });

    const rows = await client.publicPost({ slug: 'hello' });

    expect(rows).toEqual([row]);
    expect(adopted).toEqual([['post', { [ORG_ID]: row }]]);
  });

  test('onEnvelope reaches the caller, on a plain read and on .page()', async () => {
    const row = { id: ORG_ID, title: 'hello' };
    const fetch: FetchLike = async (url) =>
      Response.json(
        {
          data: url.includes('_first=')
            ? { rows: [row], endCursor: null, hasNextPage: false }
            : [row],
          records: { post: { [ORG_ID]: row } },
        },
        { headers: { [RECORDS_HEADER]: '1' } },
      );
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch });
    const seen: string[][] = [];
    const onEnvelope = (envelope: RecordEnvelope): void => {
      seen.push(Object.keys(envelope.records?.['post'] ?? {}));
    };

    await client.publicPost({ slug: 'hello' }, { onEnvelope });
    await client.publicPost.page({ slug: 'hello' }, { first: 1 }, { onEnvelope });

    expect(seen).toEqual([[ORG_ID], [ORG_ID]]);
  });

  test('a body with no header is the rows, even when it looks like an envelope', async () => {
    const { sink, adopted } = fakeSink();
    pageClient().store = sink;
    const lookalike = [{ data: 1, records: { post: [] } }];
    const fetch: FetchLike = async () => Response.json(lookalike);
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test', fetch });

    expect(await client.publicPost({ slug: 'hello' })).toEqual(lookalike as unknown as PostRow[]);
    expect(adopted).toEqual([]);
  });

  test('two concurrent identical reads are one fetchImpl call', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: FetchLike = async () => {
      calls += 1;
      await gate;
      return Response.json([{ id: ORG_ID, title: 'x' }]);
    };
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch,
      flight: createClientFlight({ principal: () => 'alice' }),
    });

    const both = Promise.all([client.publicPost({ slug: 'x' }), client.publicPost({ slug: 'x' })]);
    release();
    const [one, two] = await both;

    expect(calls).toBe(1);
    expect(one).toEqual(two);
    expect(one).not.toBe(two);
  });
});
