// A route rendered only to weigh is rendered at real paths: its own `prerender()` list for a
// dynamic one, and never an empty param — which failed the page's own schema and was filed as a
// gap in the build.

import { afterEach, describe, expect, test } from 'bun:test';
import { clearRoutes, defineRoute, registerRoute, routeEntries } from '@ultimat3/render';
import { fillPath, measurePaths } from './measure-paths';

afterEach(() => clearRoutes());

const route = (
  prerender?: () => readonly Record<string, string>[],
  render: 'ssr' | 'isr' = 'isr',
) =>
  defineRoute({
    render,
    ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
    hydrate: 'visible',
    offline: 'runtime',
    budget: { js: '60kb' },
    ...(prerender === undefined ? {} : { prerender }),
    meta: () => ({ title: 'Post', description: 'x'.repeat(60) }),
  });

const entryFor = (
  file: string,
  prerender?: () => readonly Record<string, string>[],
  render: 'ssr' | 'isr' = 'isr',
) => {
  registerRoute({ file, config: route(prerender, render) });
  const entry = routeEntries().find((one) => one.file === file);
  if (entry === undefined) return expect.unreachable(`${file} did not register`);
  return entry;
};

describe('unit · the paths a measurement render uses', () => {
  test('a static path is its own, and a param is filled and encoded', () => {
    expect(fillPath('/blog', {})).toBe('/blog');
    expect(fillPath('/blog/:slug', { slug: 'a b' })).toBe('/blog/a%20b');
    expect(fillPath('/docs/*rest', { rest: 'a/b c' })).toBe('/docs/a/b%20c');
  });

  test('a dynamic route with prerender() is rendered at each path it lists', async () => {
    const plan = await measurePaths(
      entryFor('apps/web/site/posts/[id]/page.tsx', () => [{ id: 'p1' }, { id: 'p2' }]),
    );
    expect(plan).toEqual({
      paths: [
        { path: '/posts/p1', params: { id: 'p1' } },
        { path: '/posts/p2', params: { id: 'p2' } },
      ],
    });
  });

  test('a dynamic route with none is its own finding, naming the edit, and renders nothing', async () => {
    const plan = await measurePaths(entryFor('apps/web/site/posts/[id]/page.tsx'));
    if (!('unmeasured' in plan)) return expect.unreachable('a path was invented for /posts/:id');
    expect(plan.unmeasured.code).toBe('X_BUDGET_PARAMS_UNDECLARED');
    expect(plan.unmeasured.fix).toContain("prerender: () => [{ id: 'a-real-id' }]");
  });

  test('an ssr route with params is unweighable, not a finding: it may not declare prerender()', async () => {
    const plan = await measurePaths(entryFor('apps/web/app/posts/[id]/page.tsx', undefined, 'ssr'));
    if (!('unmeasured' in plan)) return expect.unreachable('a path was invented for an ssr route');
    expect(plan.unmeasured.weighable).toBe(false);
    expect(plan.unmeasured.code).toBeUndefined();
  });
});
