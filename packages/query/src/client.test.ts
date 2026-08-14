import { describe, expect, test } from 'bun:test';
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

    expect(error).toBeUltimateError('X_RPC_FAILED');
    expect((error as { cause: string }).cause).toContain('publicPost returned HTTP 502');
  });

  test('headers and an abort signal reach the wire', async () => {
    const { fetch, seen } = recorder();
    const controller = new AbortController();
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch,
      headers: { 'accept-language': 'es' },
    });

    await client.publicPost({ slug: 'hello' }, { signal: controller.signal });

    const headers = new Headers(seen.init?.headers);
    expect(headers.get('accept-language')).toBe('es');
    expect(headers.get('accept')).toBe('application/json');
    expect(seen.init?.signal).toBe(controller.signal);
  });

  test('a symbol property is undefined, so the client is not mistaken for a thenable', async () => {
    // `await client` would otherwise read `then` off the proxy and call a read named "then".
    const client = queryClient<typeof queries>({ baseUrl: 'https://app.test' });
    const asRecord = client as unknown as Record<symbol, unknown>;

    expect(asRecord[Symbol.toPrimitive]).toBeUndefined();
    expect(asRecord[Symbol.iterator]).toBeUndefined();
  });
});
