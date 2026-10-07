// The router's one request, with `fetch` answered by the test: which headers the server's gate
// reads (and the build on a GET only), `redirect: 'manual'`, and the answer read ONCE — a page's
// text, a non-page's bytes, a prefetch's non-page body dropped, a hand-over resolved.
import { describe, expect, test } from 'bun:test';
import { FakeDocument, fakeWindow, routerHead } from './navigation-dom-fixture';
import { fetchDocument, metaOf } from './navigation-fetch';

const doc = (scope?: string) =>
  new FakeDocument(routerHead('A', [], scope === undefined ? {} : { scope }));

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

const answering = (response: () => Response | Record<string, unknown>) => {
  const seen: Seen[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(response() as Response);
  };
  return { seen, fetch };
};

const run = (d: FakeDocument, fetch: (url: string, init?: RequestInit) => Promise<Response>) => {
  const win = fakeWindow(d, 'https://app.test/a', fetch) as unknown as Window;
  return (url: string, purpose: 'soft' | 'prefetch', init?: RequestInit) =>
    fetchDocument(win, d as unknown as Document, url, purpose, init);
};

describe('fetchDocument — the request', () => {
  test('a GET names purpose, surface, principal and build; manual redirects; same-origin', async () => {
    const { seen, fetch } = answering(
      () => new Response('<p>', { headers: { 'content-type': 'text/html' } }),
    );
    await run(doc('member:1'), fetch)('https://app.test/b', 'soft');
    const init = seen[0]?.init;
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toEqual({
      accept: 'text/html,application/xhtml+xml',
      'x-ultimate-navigation': 'soft',
      'x-ultimate-surface': 'web:app',
      'x-ultimate-navigation-scope': 'member:1',
      'x-ultimate-build': 'b1',
    });
  });

  test('a POST never carries the build — it is never refused mid-submit; no scope, no header', async () => {
    const { seen, fetch } = answering(() => new Response(null, { status: 204 }));
    const bare = new FakeDocument();
    await run(bare, fetch)('https://app.test/b', 'soft', { method: 'POST' });
    expect(seen[0]?.init?.headers).toEqual({
      accept: 'text/html,application/xhtml+xml',
      'x-ultimate-navigation': 'soft',
      'x-ultimate-surface': '',
    });
  });
});

describe('fetchDocument — the browser HTTP cache never answers (#693)', () => {
  // The router's own 30 s cache is the only reuse layer: a page cached `public, max-age=0,
  // stale-while-revalidate` would otherwise be served stale after a write, a sign-out or a deploy.
  for (const [name, purpose, init] of [
    ['a soft GET', 'soft', undefined],
    ['a prefetch', 'prefetch', undefined],
    ['a POST', 'soft', { method: 'POST' }],
    ['a caller asking for the cache', 'soft', { cache: 'force-cache' }],
  ] as const) {
    test(`${name} revalidates with the server: cache 'no-cache'`, async () => {
      const { seen, fetch } = answering(() => new Response(null, { status: 204 }));
      await run(doc(), fetch)('https://app.test/b', purpose, init);
      expect(seen[0]?.init?.cache).toBe('no-cache');
    });
  }
});

describe('fetchDocument — the answer, read once', () => {
  test('a page: its text, its build, no-store read off cache-control', async () => {
    const { fetch } = answering(
      () =>
        new Response('<html>', {
          headers: {
            'content-type': 'text/html',
            'x-ultimate-build': 'b2',
            'cache-control': 'private, no-store',
          },
        }),
    );
    const answer = await run(doc(), fetch)('https://app.test/b', 'soft');
    expect(answer).toMatchObject({
      status: 200,
      html: '<html>',
      build: 'b2',
      noStore: true,
      body: null,
      location: null,
    });
  });

  test('a non-page: its bytes kept for a visit, dropped unread for a guess', async () => {
    const zip = () =>
      new Response('zip', {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename=a.zip',
        },
      });
    const soft = await run(doc(), answering(zip).fetch)('https://app.test/d', 'soft');
    expect(await soft.body?.text()).toBe('zip');
    expect(soft.disposition).toBe('attachment; filename=a.zip');
    const guess = await run(doc(), answering(zip).fetch)('https://app.test/d', 'prefetch');
    expect(guess.body).toBeNull();
  });

  test('a hand-over resolves its location against the URL asked for', async () => {
    const { fetch } = answering(
      () =>
        new Response(null, { status: 204, headers: { 'x-ultimate-location': '/login?next=%2Fb' } }),
    );
    const answer = await run(doc(), fetch)('https://app.test/b', 'soft');
    expect(answer).toMatchObject({
      status: 204,
      location: 'https://app.test/login?next=%2Fb',
      html: null,
      body: null,
    });
  });

  test('an opaque redirect is read as nothing but that', async () => {
    const { fetch } = answering(() => ({
      type: 'opaqueredirect',
      status: 0,
      headers: new Headers(),
    }));
    const answer = await run(doc(), fetch)('https://app.test/b', 'soft');
    expect(answer).toMatchObject({ opaqueRedirect: true, html: null, body: null, contentType: '' });
  });

  test('metaOf: a named meta, or null', () => {
    const d = doc('member:1') as unknown as Document;
    expect(metaOf(d, 'ultimate-scope')).toBe('member:1');
    expect(metaOf(d, 'absent')).toBeNull();
  });
});
