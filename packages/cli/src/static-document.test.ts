// A `static` page from a served process: rendered once when the boot asks for it, a 304 when the
// browser already holds the bytes — and neither for any other mode, a query string, or a 404.
import { afterEach, describe, expect, test } from 'bun:test';
import type { RenderMode } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute, withStatus } from '@ultimat3/render';
import { appRoutes } from './runtime-render';
import { createStaticMemo } from './static-document';

const BUILD_ID = 'build-under-test';

afterEach(() => {
  clearRoutes();
});

const loads: string[] = [];

function page(
  file: string,
  render: RenderMode,
  options: { cache?: 'no-store'; status?: number } = {},
): void {
  registerRoute({
    file,
    suspenseBoundaries: render === 'stream' ? 1 : 0,
    config: defineRoute({
      render,
      offline: render === 'static' ? 'precache' : 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(render === 'isr' ? { revalidate: { ttl: '1h', tags: [] } } : {}),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      load: ({ url }) => {
        loads.push(new URL(url).pathname + new URL(url).search);
        const data = { n: loads.length };
        return options.status === undefined ? data : withStatus(options.status, data);
      },
      meta: () => ({ title: file, description: 'static document under test' }),
    }),
  });
}

const serverFor = (memoStatic: boolean) =>
  createServer({
    routes: appRoutes({ buildId: BUILD_ID, memoStatic }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const get = (
  server: ReturnType<typeof serverFor>,
  path: string,
  headers: Record<string, string> = {},
) =>
  server.fetch(
    new Request(`http://app.test${path}`, { headers: { accept: 'text/html', ...headers } }),
  );

describe('a static page, revalidated', () => {
  test('a matching If-None-Match is a 304 with no body, the validators kept', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    const server = serverFor(false);
    const first = await get(server, '/precios');
    const etag = first.headers.get('etag') as string;
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[^"]+"$/);

    const again = await get(server, '/precios', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    // A weak comparison and a list both match (RFC 9110 §13.1.2).
    expect((await get(server, '/precios', { 'if-none-match': `"other", W/${etag}` })).status).toBe(
      304,
    );
  });

  test('a validator that does not match gets the whole document', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    const answer = await get(serverFor(false), '/precios', { 'if-none-match': '"stale"' });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('<!doctype html>');
  });

  test('an ssr page and a no-store page never answer 304', async () => {
    page('apps/web/app/panel/page.tsx', 'ssr');
    page('apps/web/app/privado/page.tsx', 'ssr', { cache: 'no-store' });
    const server = serverFor(true);
    for (const path of ['/panel', '/privado']) {
      const answer = await get(server, path, { 'if-none-match': '*' });
      expect(answer.status).toBe(200);
    }
  });

  test('a 404 rendered under static is sent whole, even to `If-None-Match: *`', async () => {
    page('apps/web/site/gone/page.tsx', 'static', { status: 404 });
    const answer = await get(serverFor(true), '/gone', { 'if-none-match': '*' });
    expect(answer.status).toBe(404);
    expect(await answer.text()).toContain('<!doctype html>');
  });
});

describe('a static page, rendered once', () => {
  test('memoStatic: the second request runs neither load nor a render, and is the same bytes', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    loads.length = 0;
    const server = serverFor(true);
    const first = await get(server, '/precios');
    const second = await get(server, '/precios');
    expect(loads).toEqual(['/precios']);
    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    // And the kept copy still revalidates.
    const third = await get(server, '/precios', {
      'if-none-match': first.headers.get('etag') as string,
    });
    expect(third.status).toBe(304);
    expect(loads).toEqual(['/precios']);
  });

  test('without memoStatic (x dev) every request renders', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    loads.length = 0;
    const server = serverFor(false);
    await get(server, '/precios');
    await get(server, '/precios');
    expect(loads).toEqual(['/precios', '/precios']);
  });

  test('a query string, a dynamic segment, an ssr page and a 404 are rendered per request', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    page('apps/web/site/blog/[slug]/page.tsx', 'static');
    page('apps/web/app/panel/page.tsx', 'ssr');
    page('apps/web/site/gone/page.tsx', 'static', { status: 404 });
    loads.length = 0;
    const server = serverFor(true);
    for (const path of ['/precios?a=1', '/blog/x', '/panel', '/gone']) {
      await get(server, path);
      await get(server, path);
    }
    expect(loads).toEqual([
      '/precios?a=1',
      '/precios?a=1',
      '/blog/x',
      '/blog/x',
      '/panel',
      '/panel',
      '/gone',
      '/gone',
    ]);
  });
});

describe('createStaticMemo', () => {
  const result = (status = 200) => ({ status, headers: {}, body: 'x' });

  test('past its limit a new key is not kept, and a kept one still answers', () => {
    const memo = createStaticMemo(1);
    memo.set('a', result());
    memo.set('b', result());
    expect(memo.get('a')).toBeDefined();
    expect(memo.get('b')).toBeUndefined();
    expect(memo.size).toBe(1);
  });

  test('only a 200 is kept', () => {
    const memo = createStaticMemo();
    memo.set('a', result(404));
    expect(memo.get('a')).toBeUndefined();
  });
});
