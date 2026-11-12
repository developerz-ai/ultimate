// A public `ssr` page answers with the validator `renderSsr` stamps, and a request naming it is a
// bodiless 304 — through the whole pipeline, `compress` included, so the 304 carries the 200's form.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'etag-under-test';

afterEach(() => {
  clearRoutes();
});

function ssrPage(file: string, body: string): void {
  registerRoute({
    file,
    component: () => body,
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      meta: () => ({ title: file, description: 'a public page rendered per request' }),
    }),
  });
}

const serve = () =>
  httpServer({
    routes: appRoutes({ buildId: BUILD_ID }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const get = (server: ReturnType<typeof serve>, headers: Record<string, string> = {}) =>
  server.fetch(
    new Request('http://app.test/feed', { headers: { accept: 'text/html', ...headers } }),
  );

describe('unit · a public ssr page revalidates', () => {
  test('the 200 names a validator, and naming it back is a 304 with no body', async () => {
    ssrPage('apps/web/site/feed/page.tsx', 'the feed');
    const server = serve();
    const first = await get(server);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('s-maxage');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{8}"$/);
    const again = await get(server, { 'if-none-match': etag ?? '' });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
  });

  test('offered a coding, the 304 answers the weak form the 200 did', async () => {
    ssrPage('apps/web/site/feed/page.tsx', 'the feed '.repeat(300));
    const server = serve();
    const first = await get(server, { 'accept-encoding': 'gzip' });
    const etag = first.headers.get('etag') ?? '';
    expect(etag.startsWith('W/"')).toBe(true);
    const again = await get(server, { 'accept-encoding': 'gzip', 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  test('a stale validator gets the page', async () => {
    ssrPage('apps/web/site/feed/page.tsx', 'the feed');
    const again = await get(serve(), { 'if-none-match': '"00000000"' });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('the feed');
  });
});
