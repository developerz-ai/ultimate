import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { RouteDuplicateError, RouteFileInvalidError } from './errors';
import {
  clearRoutes,
  describeRoutes,
  matchRoute,
  registerRoute,
  routeEntries,
  routePathFromFile,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';
import type { Surface } from './surfaces';

/** The thrown error itself, so a test can assert on `code`, `cause` and `fix` together. */
const thrownBy = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  // `expect.unreachable` fails through the runner, so the caller sees its own assertion rather
  // than a stack from inside this helper — and a bare throw here would carry no code and no fix.
  return expect.unreachable('expected an UltimateError');
};

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

describe('one route filename per surface', () => {
  // Every spelling the framework used to accept, or that a Next/Vite habit produces. Each one is
  // now a build error: two spellings make "is this file a route?" undecidable from the folder.
  test.each([
    ['apps/web/site/pricing.tsx', 'apps/web/site/pricing/page.tsx'],
    ['apps/web/site/blog/[slug].tsx', 'apps/web/site/blog/[slug]/page.tsx'],
    ['apps/web/app/feed.tsx', 'apps/web/app/feed/page.tsx'],
  ])('%s is refused, and the fix creates the directory it always meant', (file, target) => {
    const failure = thrownBy(() => routePathFromFile(file));
    expect(failure).toBeInstanceOf(RouteFileInvalidError);
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.cause).toContain(file);
    expect(failure.fix).toBe(
      `mkdir -p ${target.slice(0, target.lastIndexOf('/'))} && git mv ${file} ${target}`,
    );
  });

  test.each([
    ['apps/web/site/index.tsx', 'apps/web/site/page.tsx'],
    ['apps/web/site/blog/index.tsx', 'apps/web/site/blog/page.tsx'],
    // `route.ts` is the api/ spelling and `page.tsx` the page one — each is wrong on the other
    // surface, and both already meant "this directory", so the repair is a rename in place.
    ['apps/web/app/reports/route.ts', 'apps/web/app/reports/page.tsx'],
    ['apps/web/api/posts/page.tsx', 'apps/web/api/posts/route.ts'],
  ])('%s already meant its directory, so the fix renames in place', (file, target) => {
    const failure = thrownBy(() => routePathFromFile(file));
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.fix).toBe(`git mv ${file} ${target}`);
  });

  test('shared/ is a leaf: no filename makes a route there', () => {
    const failure = thrownBy(() => routePathFromFile('apps/web/shared/page.tsx'));
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.cause).toContain('shared/');
  });

  test('registerRoute refuses it too — the table never holds an unnameable file', () => {
    expect(() =>
      registerRoute({ file: 'apps/web/site/pricing.tsx', config: staticConfig }),
    ).toThrow(RouteFileInvalidError);
    expect(routeEntries()).toHaveLength(0);
  });

  test('a path override does not buy an exemption: the file still has to be a route file', () => {
    // `path` exists for locale roots and rewrites, not as a way around the naming rule — the
    // module scan still has to recognise the file, and the override says nothing about that.
    expect(() =>
      registerRoute({ file: 'apps/web/site/pricing.tsx', config: staticConfig, path: '/tarifs' }),
    ).toThrow(RouteFileInvalidError);
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
