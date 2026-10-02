// A value an app hands the route layer is reported, never re-thrown as the frame's own `TypeError`:
// `defineRoute`'s keys, `prerender()`'s items and params, an island resolver's answer, `asset()`'s
// path — each one a coded refusal whose cause renders the value safely. Plus the stream's default
// error fallback, which writes a hole id into an attribute through the one escaper.
import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { asset } from './asset';
import { clearDeclaredIslands } from './island';
import { createIslandCollector } from './island-collector';
import { clearRoutes, registerRoute } from './registry';
import { enumeratePrerender, fillPath, renderStatic } from './render-static';
import { collectStream, holeMarker, renderStreamHtml } from './render-stream';
import type { PrerenderFn, RouteDefinition, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta: RouteMetaFn = () => ({ title: 'T', description: 'd'.repeat(60) });

/** The code a call refused with; a bare `TypeError` (or nothing) fails the test. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    return expect.unreachable(`a bare ${Object.prototype.toString.call(error)} escaped`);
  }
  return expect.unreachable('nothing was refused');
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    return expect.unreachable(`a bare ${Object.prototype.toString.call(error)} escaped`);
  }
  return expect.unreachable('nothing was refused');
}

const define = (over: Record<string, unknown>) => () =>
  defineRoute({
    render: 'ssr',
    offline: 'runtime',
    hydrate: 'never',
    meta,
    ...over,
  } as unknown as RouteDefinition);

afterEach(() => {
  clearRoutes();
  clearDeclaredIslands();
});

describe('defineRoute renders a key it refuses, whatever its type', () => {
  test.each([
    ['render', 'X_ROUTE_MODE_INVALID'],
    ['hydrate', 'X_ROUTE_MODE_INVALID'],
    ['offline', 'X_ROUTE_OFFLINE_MISSING'],
    ['load', 'X_ROUTE_LOAD_INVALID'],
  ])('%s: 1n', (key, code) => {
    expect(codeOf(define({ [key]: 1n }))).toBe(code);
  });
});

function blog(prerender: PrerenderFn) {
  return registerRoute({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    config: defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      meta,
      prerender,
    }),
  });
}

describe('prerender() hands back data, never a crash in the build', () => {
  test.each([
    ['a null item', [null]],
    ['a number item', [7]],
    ['a param that is a number', [{ slug: 7 }]],
    ['a param that is null', [{ slug: null }]],
    ['an array item', [['a']]],
  ])('%s is X_PRERENDER_FAILED', async (_name, produced) => {
    const entry = blog(async () => produced as never);
    const code = await asyncCodeOf(() =>
      renderStatic(entry, async () => '<p></p>', { buildId: 'b1' }),
    );
    expect(code).toBe('X_PRERENDER_FAILED');
  });

  test('a catch-all param that is not text is refused too, and so are params that are not an object', () => {
    expect(codeOf(() => fillPath('/docs/*path', { path: 7 as never }))).toBe('X_PRERENDER_FAILED');
    expect(codeOf(() => fillPath('/blog/:slug', null as never))).toBe('X_PRERENDER_FAILED');
  });

  test('a plain object of strings still enumerates', async () => {
    const entry = blog(async () => [{ slug: 'a' }, 'b']);
    expect(await enumeratePrerender(entry)).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });
});

describe('the other doors', () => {
  test('an island resolver answering a non-string is X_ISLAND_INVALID', () => {
    const collector = createIslandCollector({
      file: 'apps/web/site/pricing/page.tsx',
      hydrate: 'idle',
      resolve: () => 1n as never,
    });
    const spec = { moduleId: 'cart', src: './cart.island.tsx', propKeys: [], tag: 'div' };
    expect(codeOf(() => collector.record(spec, {}))).toBe('X_ISLAND_INVALID');
  });

  test('asset() with no path is X_ASSET_MISSING', () => {
    expect(codeOf(() => asset(undefined as never))).toBe('X_ASSET_MISSING');
  });
});

describe("the stream's default error fallback", () => {
  test('escapes the hole id, as holeMarker does', async () => {
    const id = 'x"><img src=x onerror=alert(1)>';
    const html = await collectStream(
      renderStreamHtml(
        {
          head: '<html><body>',
          shell: holeMarker(id, 'skeleton'),
          holes: [{ id, fallback: 'skeleton', resolve: () => Promise.reject(new Error('down')) }],
        },
        { buildId: 'b1' },
      ),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('data-x-hole-error="x&quot;&gt;&lt;img');
  });
});
