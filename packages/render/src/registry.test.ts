import { beforeEach, describe, expect, test } from 'bun:test';
import { RouteDuplicateError } from './errors';
import {
  clearRoutes,
  describeRoutes,
  matchRoute,
  registerRoute,
  routePathFromFile,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';
import type { Surface } from './surfaces';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const staticConfig = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  meta,
});

beforeEach(() => {
  clearRoutes();
});

describe('routePathFromFile', () => {
  test.each<[string, Surface, string]>([
    ['apps/web/site/page.tsx', 'site', '/'],
    ['apps/web/site/pricing/page.tsx', 'site', '/pricing'],
    ['apps/web/site/(marketing)/about/page.tsx', 'site', '/about'],
    ['apps/web/site/blog/[slug]/page.tsx', 'site', '/blog/:slug'],
    ['apps/web/site/docs/[...path]/page.tsx', 'site', '/docs/*path'],
    ['apps/web/app/dashboard/page.tsx', 'app', '/dashboard'],
    ['apps/web/api/posts/route.ts', 'api', '/api/posts'],
  ])('%s → %s %s', (file, surface, path) => {
    expect(routePathFromFile(file)).toEqual({ surface, path });
  });
});

describe('route table', () => {
  test('two files claiming one URL is a build error', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: staticConfig });
    expect(() =>
      registerRoute({ file: 'apps/web/site/(marketing)/pricing/page.tsx', config: staticConfig }),
    ).toThrow(RouteDuplicateError);
  });

  test('describeRoutes is sorted, JSON-safe and identical for identical input', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/blog/[slug]/page.tsx', config: staticConfig });

    const first = describeRoutes();
    expect(first.map((r) => r.path)).toEqual(['/', '/blog/:slug', '/pricing']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(describeRoutes()));
    expect(first.find((r) => r.path === '/blog/:slug')?.dynamic).toBe(true);
  });

  test('matchRoute prefers the more specific pattern', () => {
    registerRoute({ file: 'apps/web/site/blog/[slug]/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/blog/feed/page.tsx', config: staticConfig });

    expect(matchRoute('/blog/feed')?.entry.path).toBe('/blog/feed');
    const dynamic = matchRoute('/blog/hello-world');
    expect(dynamic?.entry.path).toBe('/blog/:slug');
    expect(dynamic?.params).toEqual({ slug: 'hello-world' });
    expect(matchRoute('/nope')).toBe(null);
  });
});
