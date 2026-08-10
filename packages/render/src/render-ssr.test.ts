/**
 * `render-ssr` wraps a per-request render into a `RenderResult` and decides cacheability:
 * gated routes get `private, no-store` and `Vary: cookie`, public ones stay CDN-cacheable.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import { clearRoutes, registerRoute } from './registry';
import type { SsrRenderInput } from './render-ssr';
import { renderSsr, ssrHeaders } from './render-ssr';
import type { RouteGuard, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

function ssrRoute(file: string, policy?: RouteGuard) {
  return registerRoute({
    file,
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      meta,
      ...(policy ? { policy } : {}),
    }),
  });
}

function ssrInput(file: string, policy?: RouteGuard): SsrRenderInput {
  return {
    entry: ssrRoute(file, policy),
    params: {},
    url: new URL('https://example.com/pricing'),
    ctx: createContext({}),
  };
}

beforeEach(() => {
  clearRoutes();
});

describe('renderSsr', () => {
  test('wraps a synchronous render with status 200 by default', async () => {
    const input = ssrInput('apps/web/site/pricing/page.tsx');
    const result = await renderSsr(input, () => '<p>pricing</p>', { buildId: 'b1' });

    expect(result.status).toBe(200);
    expect(result.body).toBe('<p>pricing</p>');
    expect(result.headers).toEqual(ssrHeaders(input.entry, { buildId: 'b1' }));
  });

  test('wraps an async render and honors an explicit status', async () => {
    const input = ssrInput('apps/web/site/pricing/page.tsx');
    const result = await renderSsr(input, async () => '<p>pricing</p>', {
      buildId: 'b1',
      status: 404,
    });

    expect(result.status).toBe(404);
    expect(result.body).toBe('<p>pricing</p>');
  });
});

describe('ssrHeaders', () => {
  test('an ungated route is public and revalidating, with no cookie in vary', () => {
    const entry = ssrRoute('apps/web/site/pricing/page.tsx');
    const headers = ssrHeaders(entry, { buildId: 'b1' });

    expect(headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    );
    expect(headers['vary']).not.toContain('cookie');
  });

  test('a gated route is private, no-store, and vary includes cookie', () => {
    const entry = ssrRoute('apps/web/app/dashboard/page.tsx', { permission: 'dashboard:read' });
    const headers = ssrHeaders(entry, { buildId: 'b1' });

    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['vary']).toContain('cookie');
  });

  test('vary always includes accept-language and merges extra dimensions', () => {
    const entry = ssrRoute('apps/web/site/pricing/page.tsx');
    const headers = ssrHeaders(entry, { buildId: 'b1', vary: ['x-tenant'] });

    expect(headers['vary']).toBe('accept-language, x-tenant');
  });

  test('vary is alphabetically sorted, even when that differs from insertion order', () => {
    const entry = ssrRoute('apps/web/app/dashboard/page.tsx', { permission: 'dashboard:read' });
    // insertion order is accept-language, x-tenant, cookie — sorted puts cookie first.
    const headers = ssrHeaders(entry, { buildId: 'b1', vary: ['x-tenant'] });

    expect(headers['vary']).toBe('accept-language, cookie, x-tenant');
  });

  test('x-ultimate-build matches options.buildId', () => {
    const entry = ssrRoute('apps/web/site/pricing/page.tsx');
    expect(ssrHeaders(entry, { buildId: 'build-42' })['x-ultimate-build']).toBe('build-42');
  });
});
