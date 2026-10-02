// A `revalidate.tags` entry becomes a purge key on every response of the route. One a CDN would
// split — whitespace, a comma — is refused where the route is DECLARED, naming the file: found at
// serve time it is a 500 on a public page, and found at purge time it is a page nothing can clear.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { tag } from '@ultimat3/cache';
import { isUltimateError } from '@ultimat3/core';
import {
  clearRoutes,
  describeRoutes,
  registerMountedRoutes,
  registerRoute,
  routeCount,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const FILE = 'apps/web/site/blog/page.tsx';

const isr = (tags: readonly CacheTag[]) =>
  defineRoute({
    render: 'isr',
    revalidate: { tags },
    offline: 'precache',
    hydrate: 'never',
    meta,
  });

const refusal = (fn: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    fn();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable('the refusal was not a coded error');
  }
  return expect.unreachable('an unpurgeable tag was registered');
};

beforeEach(clearRoutes);
afterAll(clearRoutes);

describe('an unpurgeable revalidate tag is refused at registration', () => {
  test.each([
    ['whitespace in a row id', tag('post', 'a b'), 'post:a b'],
    ['a comma in a row id', tag('post', 'a,b'), 'post:a,b'],
    ['whitespace in the entity', tag('blog post'), 'blog post'],
  ] as const)('%s', (_name, bad, wire) => {
    const error = refusal(() => registerRoute({ file: FILE, config: isr([tag('feed'), bad]) }));
    expect(error.code).toBe('X_ROUTE_MODE_INVALID');
    expect(error.cause).toContain(FILE);
    expect(error.cause).toContain(JSON.stringify(wire));
    expect(error.fix).toContain(FILE);
    // Refused, not half-registered: the route table does not hold it.
    expect(routeCount()).toBe(0);
  });

  test('a mounted route is screened the same way, naming its mount', () => {
    const error = refusal(() =>
      registerMountedRoutes(
        { key: '/shop', by: 'defineShop', file: '@acme/shop', surface: 'site' },
        [{ path: '/shop', config: isr([tag('product', 'a b')]), permissions: [] }],
      ),
    );
    expect(error.code).toBe('X_ROUTE_MODE_INVALID');
    expect(error.cause).toContain('@acme/shop');
    expect(describeRoutes()).toEqual([]);
  });

  test('purgeable tags register, and reach the descriptor as wire tags', () => {
    registerRoute({ file: FILE, config: isr([tag('post'), tag('post', '0191-ab_c.d')]) });
    expect(describeRoutes()[0]?.revalidateTags).toEqual(['post', 'post:0191-ab_c.d']);
  });
});
