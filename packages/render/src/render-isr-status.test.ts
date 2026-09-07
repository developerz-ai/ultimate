// An `isr` render that answers a status — split out of `render-isr.test.ts` on 2026-09-07 when
// the status seam pushed that file past the 500-line ceiling. The helpers are the same shape.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describeRoutes, registerRoute } from './registry';
import { createIsrController, isrKey, memoryIsrStore } from './render-isr';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

/** The store key for a path in this file's one locale — `isrKey` owns the derivation. */
const isrKeyOf = (path: string): string => isrKey(new URL(`https://app.test${path}`), 'en');

const postTag: CacheTag = tag('post');
const _orgTag: CacheTag = tag('org');

function isrRoute(file: string, tags: readonly CacheTag[], ttl?: string): void {
  registerRoute({
    file,
    config: defineRoute({
      render: 'isr',
      revalidate: ttl === undefined ? { tags } : { tags, ttl },
      offline: 'precache',
      hydrate: 'never',
      meta,
    }),
  });
}

function _sMaxAge(result: RenderResult): string | undefined {
  return /s-maxage=(\d+)/.exec(result.headers['cache-control'] ?? '')?.[1];
}

// An empty graph is this file's subject, so the per-test reset stays. What it owes the process is
// the restore: a reset drops the edges a neighbour registered, and the leak guard reports
// additions only — so a destructive cleanup surfaces as a failure in an innocent file.
const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

afterAll(() => {
  // The graph AND the registry. `beforeEach` clears routes for this file's own sake; this clears
  // them for everyone else's — the registry is process-global, so the last test in this file left
  // its routes visible to every suite that ran after it, in whatever order `bun test` chose.
  clearRoutes();
  restoreGraph();
});

describe('a render that answers a status', () => {
  // `IsrEntry` held only HTML, so an `isr` page whose loader said 404 was stored and served as a
  // 200 — for the whole TTL, and the CDN was told to do the same. The render may now hand back
  // `{ html, status }`; a bare string is still the 200 it always was.
  test('a bare string is 200, as every render before this one was', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    const served = await controller.serve(isrKeyOf('/blog/a'), () => '<p>a</p>');
    expect(served.result.status).toBe(200);
    expect(served.entry.status).toBe(200);
  });

  test('{ html, status: 404 } is served as a 404, on the miss and on every hit after it', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    const render = () => ({ html: '<p>no such post</p>', status: 404 });
    const miss = await controller.serve(isrKeyOf('/blog/nope'), render);
    expect(miss.state).toBe('miss');
    expect(miss.result.status).toBe(404);
    expect(miss.result.body).toBe('<p>no such post</p>');
    const hit = await controller.serve(isrKeyOf('/blog/nope'), render);
    expect(hit.state).toBe('hit');
    expect(hit.result.status).toBe(404);
  });

  test('the stale copy keeps its status while the refresh runs behind it', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    const key = isrKeyOf('/blog/late');
    await controller.serve(key, () => ({ html: '<p>gone</p>', status: 410 }));
    controller.markStale(key);
    const stale = await controller.serve(key, () => '<p>back</p>');
    expect(stale.state).toBe('stale');
    expect(stale.result.status).toBe(410);
  });

  test('a status new Response() would refuse fails the regeneration by name', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    await expect(
      controller.serve(isrKeyOf('/blog/x'), () => ({ html: '<p>x</p>', status: Number.NaN })),
    ).rejects.toMatchObject({ code: 'X_INVARIANT' });
  });

  test('an entry a custom store round-tripped without a status is served as 200, never NaN', async () => {
    // A Redis-backed `IsrStore` JSON-round-trips its entries; a field that was never written comes
    // back absent. `entryTtlMs` already takes that path for the TTL — the status takes the same one.
    const store = memoryIsrStore();
    store.set({
      path: '/blog/old',
      html: '<p>old</p>',
      hash: 'h',
      generatedAt: Date.now(),
      ttlMs: null,
      stale: false,
    });
    const controller = createIsrController({ store, routes: describeRoutes });
    const served = await controller.serve('/blog/old', () => '<p>never called</p>');
    expect(served.state).toBe('hit');
    expect(served.result.status).toBe(200);
  });
});
