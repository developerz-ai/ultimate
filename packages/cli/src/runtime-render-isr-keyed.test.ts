// An `isr` page over HTTP: the query it is keyed on is the route's declaration, the origin it names
// is never a stranger's, and a failed read is never the stored page. Reported by an app's security
// review of its first `isr` routes — any query string minted a stored entry, and a `withStatus(503)`
// was served for the whole TTL.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { isolateGraph } from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, noStore, registerRoute, withStatus } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { ISR_MAX_REQUEST_ORIGINS } from './runtime-isr-outcome';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-keyed-under-test';
let loads = 0;
/** What the next `load` answers: the page, the app's 503, or an answer it asks not to be kept. */
let read: 'ok' | 'down' | 'preview' = 'ok';
const seenUrls: string[] = [];

const pageOf = (data: unknown): string =>
  typeof data === 'object' && data !== null && 'page' in data ? String(data.page) : '?';

function registerBlog(query?: readonly string[]): void {
  registerRoute({
    file: 'apps/web/site/blog/page.tsx',
    component: (props: { readonly data?: unknown; readonly query?: Record<string, string> }) =>
      h('p', {}, `page ${pageOf(props.data)} query ${JSON.stringify(props.query ?? {})}`),
    config: defineRoute({
      render: 'isr',
      revalidate: query === undefined ? { ttl: '5m' } : { ttl: '5m', query },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: ({ url }) => {
        loads += 1;
        seenUrls.push(url);
        const data = { page: new URL(url).searchParams.get('pagina') ?? '1' };
        if (read === 'down') return withStatus(503, data);
        return read === 'preview' ? noStore(data) : data;
      },
      meta: ({ url }) => ({ title: 'Blog', description: 'an isr page', canonical: url }),
    }),
  });
}

const restoreGraph = isolateGraph();

afterEach(() => {
  clearRoutes();
  loads = 0;
  read = 'ok';
  seenUrls.length = 0;
});

afterAll(() => {
  isrController().attach()();
  restoreGraph();
});

function serving(origin?: string) {
  // No cooldown: these tests ask what the very next request gets, not what the next second does.
  const { isr, release } = attachedIsr({ buildId: BUILD_ID, failureCooldownMs: 0 });
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr, ...(origin === undefined ? {} : { origin }) }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const get = (path: string, host = 'dev.test') =>
    server.fetch(new Request(`http://${host}${path}`));
  return { isr, release, get };
}

describe('unit · an isr page keys on the query its route declared', () => {
  test('with no declaration a flood of query strings is one render and one stored page', async () => {
    registerBlog();
    const { isr, release, get } = serving();
    for (const n of Array.from({ length: 50 }, (_, index) => index)) {
      const body = await (await get(`/blog?flood=${n}&pagina=${n}`)).text();
      // An undeclared parameter reaches nothing: the page, its query and its canonical are `/blog`.
      expect(body).toContain('page 1 query {}');
      expect(body).toContain('<link rel="canonical" href="http://dev.test/blog"');
    }
    expect(loads).toBe(1);
    expect(isr.store().paths()).toHaveLength(1);
    expect(seenUrls).toEqual(['http://dev.test/blog']);
    release();
  });

  test('query: [] — no query string creates an entry or reaches load', async () => {
    registerBlog([]);
    const { isr, release, get } = serving();
    for (const path of ['/blog', '/blog?x=1', '/blog?x=2', '/blog?utm_source=mail&pagina=7']) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('page 1 query {}');
      // The stored page's canonical is the page's own URL, never the visitor's spelling of it.
      expect(body).toContain('<link rel="canonical" href="http://dev.test/blog"');
      expect(response.headers.get('location')).toBeNull();
    }
    expect(loads).toBe(1);
    expect(isr.store().paths()).toHaveLength(1);
    expect(seenUrls).toEqual(['http://dev.test/blog']);
    release();
  });

  test('a declared parameter is a dimension; everything beside it is not', async () => {
    registerBlog(['pagina']);
    const { isr, release, get } = serving();
    expect(await (await get('/blog?pagina=2&utm_source=mail')).text()).toContain(
      'page 2 query {&quot;pagina&quot;:&quot;2&quot;}',
    );
    expect(await (await get('/blog?fbclid=abc&pagina=2')).text()).toContain('page 2');
    expect(await (await get('/blog?pagina=3')).text()).toContain('page 3');
    expect(await (await get('/blog?gclid=1')).text()).toContain('page 1');
    expect(loads).toBe(3);
    expect(isr.store().paths()).toHaveLength(3);
    release();
  });
});

describe('unit · the origin an isr page names', () => {
  const canonicalOf = (body: string): string | undefined =>
    /<link rel="canonical" href="([^"]+)"/.exec(body)?.[1];

  test('no declared origin: each host sees its own canonical, and a later visitor is not told a stranger', async () => {
    registerBlog([]);
    const { isr, release, get } = serving();
    expect(canonicalOf(await (await get('/blog', 'evil.test')).text())).toBe(
      'http://evil.test/blog',
    );
    const visitor = await (await get('/blog', 'dev.test')).text();
    expect(canonicalOf(visitor)).toBe('http://dev.test/blog');
    expect(visitor).not.toContain('evil.test');
    expect(isr.store().paths()).toHaveLength(2);
    expect(loads).toBe(2);
    release();
  });

  test('a declared origin: one page, and load is handed the origin its canonical names', async () => {
    registerBlog([]);
    const { isr, release, get } = serving('https://public.test');
    for (const host of ['evil.test', 'dev.test']) {
      const body = await (await get('/blog', host)).text();
      expect(canonicalOf(body)).toBe('https://public.test/blog');
      expect(body).not.toContain(host);
    }
    expect(seenUrls).toEqual(['https://public.test/blog']);
    expect(loads).toBe(1);
    expect(isr.store().paths()).toHaveLength(1);
    release();
  });

  test('a declared origin replaces the port too', async () => {
    registerBlog([]);
    const { isr, release, get } = serving('https://public.test');
    const body = await (await get('/blog', 'evil.test:8443')).text();
    expect(canonicalOf(body)).toBe('https://public.test/blog');
    expect(seenUrls).toEqual(['https://public.test/blog']);
    expect(body).not.toContain('8443');
    expect(isr.store().paths()).toHaveLength(1);
    release();
  });

  test('a declared origin keeps its own port', async () => {
    registerBlog([]);
    const { release, get } = serving('https://public.test:4443');
    await get('/blog', 'evil.test:8443');
    expect(seenUrls).toEqual(['https://public.test:4443/blog']);
    release();
  });

  test('an origin that parses but is not http(s) is no declaration: never the shared key', async () => {
    registerBlog([]);
    const { isr, release, get } = serving('localhost:3000');
    await get('/blog', 'evil.test');
    const visitor = await (await get('/blog', 'dev.test')).text();
    expect(visitor).not.toContain('evil.test');
    expect(isr.store().paths()).toHaveLength(2);
    release();
  });

  test('no declared origin: hosts past the cap are answered, uncached, and evict nothing', async () => {
    registerBlog([]);
    const { isr, release, get } = serving();
    const real = await get('/blog', 'real.test');
    expect(real.headers.get('cache-control')).toContain('s-maxage');
    const stored = isr.store().paths();
    for (let n = 0; n < ISR_MAX_REQUEST_ORIGINS * 3; n += 1) await get('/blog', `h${n}.test`);
    expect(isr.store().paths()).toHaveLength(ISR_MAX_REQUEST_ORIGINS);
    expect(isr.store().paths()).toContain(stored[0] as string);

    const before = loads;
    const refused = await get('/blog', 'one-more.test');
    expect(refused.status).toBe(200);
    expect(refused.headers.get('cache-control')).toContain('no-store');
    expect(canonicalOf(await refused.text())).toBe('http://one-more.test/blog');
    expect(loads).toBe(before + 1);
    expect(isr.store().paths()).toHaveLength(ISR_MAX_REQUEST_ORIGINS);

    // An origin admitted before the cap is still stored and still a hit.
    await get('/blog', 'real.test');
    expect(loads).toBe(before + 1);
    release();
  });

  test('a declared origin never counts toward the cap', async () => {
    registerBlog([]);
    const { isr, release, get } = serving('https://public.test');
    for (let n = 0; n < ISR_MAX_REQUEST_ORIGINS + 2; n += 1) {
      const response = await get('/blog', `h${n}.test`);
      expect(response.headers.get('cache-control')).toContain('s-maxage');
    }
    expect(isr.store().paths()).toHaveLength(1);
    release();
  });

  test('a declared origin that is no URL answers the page, against the request', async () => {
    registerBlog([]);
    const { release, get } = serving('not a url');
    const response = await get('/blog', 'dev.test');
    expect(response.status).toBe(200);
    expect(seenUrls).toEqual(['http://dev.test/blog']);
    release();
  });
});

describe('unit · an isr page whose read failed is not the stored page', () => {
  test('a withStatus(503) answers its own request, uncached, and the next request reads again', async () => {
    registerBlog();
    const { isr, release, get } = serving();
    read = 'down';
    const failed = await get('/blog');
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toContain('no-store');
    expect(isr.store().paths()).toEqual([]);

    read = 'ok';
    const recovered = await get('/blog');
    expect(recovered.status).toBe(200);
    expect(isr.store().paths()).toHaveLength(1);
    expect(loads).toBe(2);
    release();
  });

  test('noStore(data) from load is served and never kept', async () => {
    registerBlog();
    const { isr, release, get } = serving();
    read = 'preview';
    const first = await get('/blog');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    await get('/blog');
    expect(loads).toBe(2);
    expect(isr.store().paths()).toEqual([]);
    release();
  });
});
