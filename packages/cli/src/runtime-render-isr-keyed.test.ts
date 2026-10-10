// An `isr` page over HTTP: the query it is keyed on is the route's declaration, and a failed read
// is never the stored page. Reported by an app's security review of its first `isr` routes — any
// query string minted a stored entry, and a `withStatus(503)` was served for the whole TTL.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { isolateGraph } from '@ultimat3/cache';
import { setLogSink } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, noStore, registerRoute, withStatus } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
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

function serving() {
  const { isr, release } = attachedIsr({ buildId: BUILD_ID });
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const get = (path: string) => server.fetch(new Request(`http://dev.test${path}`));
  return { isr, release, get };
}

describe('unit · an isr page keys on the query its route declared', () => {
  test('with no declaration every query string is still its own page, and the route is told once', async () => {
    registerBlog();
    const { isr, release, get } = serving();
    const lines: string[] = [];
    const previous = setLogSink((line) => {
      lines.push(line);
    });
    try {
      for (const path of ['/blog', '/blog?x=1', '/blog?x=2']) await get(path);
    } finally {
      setLogSink(previous);
    }
    expect(isr.store().paths()).toHaveLength(3);
    const told = lines.filter((line) => line.includes('isr.query.undeclared'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('revalidate: { query: [] }');
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
