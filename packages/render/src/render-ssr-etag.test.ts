// An `ssr` document a cache may store carries a validator over its bytes, so `/feed` revalidated
// by a CDN or a browser is a 304 rather than the page again; one nobody may store carries none.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { clearRoutes, registerRoute } from './registry';
import { renderSsr } from './render-ssr';
import { contentHash } from './render-static';
import type { RouteCache, RouteGuard, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const input = (file: string, extra: { policy?: RouteGuard; cache?: RouteCache } = {}) => ({
  entry: registerRoute({
    file,
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      meta,
      ...extra,
    }),
  }),
  params: {},
  url: new URL('https://example.com/feed'),
  ctx: ctxOf({}),
});

beforeEach(() => {
  clearRoutes();
});

describe('renderSsr — the validator', () => {
  test('a public document carries the strong content hash of its body', async () => {
    const result = await renderSsr(input('apps/web/site/feed/page.tsx'), () => '<p>feed</p>', {
      buildId: 'b1',
    });
    expect(result.headers['cache-control']).toContain('public');
    expect(result.headers['etag']).toBe(`"${contentHash('<p>feed</p>')}"`);
  });

  test('two bodies, two validators: the tag follows the bytes, not the route', async () => {
    const one = await renderSsr(input('apps/web/site/feed/page.tsx'), () => '<p>a</p>', {
      buildId: 'b1',
    });
    const two = await renderSsr(input('apps/web/site/feed/page.tsx'), () => '<p>b</p>', {
      buildId: 'b1',
    });
    expect(one.headers['etag']).not.toBe(two.headers['etag']);
  });

  test('a private revalidated document carries one too', async () => {
    const result = await renderSsr(
      input('apps/web/app/a/page.tsx', {
        policy: { permission: 'post:read' },
        cache: { mode: 'private', maxAgeSeconds: 10 },
      }),
      () => '<p>mine</p>',
      { buildId: 'b1' },
    );
    expect(result.headers['etag']).toBe(`"${contentHash('<p>mine</p>')}"`);
  });

  test('a no-store document carries none: nothing may keep it to revalidate', async () => {
    const gated = await renderSsr(
      input('apps/web/app/dashboard/page.tsx', { policy: { permission: 'dashboard:read' } }),
      () => '<p>x</p>',
      { buildId: 'b1' },
    );
    expect(gated.headers['cache-control']).toBe('private, no-store');
    expect(gated.headers['etag']).toBeUndefined();
  });
});
