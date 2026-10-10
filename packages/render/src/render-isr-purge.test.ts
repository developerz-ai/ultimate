// What an invalidation does to a stored page is the route's choice (`revalidate.onInvalidate`), and
// how old a stale copy may be is too (`revalidate.maxStale`). Before either existed a bust marked
// the entry stale and `serve()` answered it once more HOWEVER OLD it was — per stored key, per
// replica — so a withdrawn article was served to its next visitor, possibly a crawler days later.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags, isolateGraph, isolateTiers, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';
import { memoryIsrStore } from './render-isr-store';

const postTag: CacheTag = tag('post');
const teamTag: CacheTag = tag('team');
const POST = 'apps/web/site/blog/[slug]/page.tsx';

const restoreGraph = isolateGraph();
const restoreTiers = isolateTiers();

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

afterAll(() => {
  clearRoutes();
  restoreGraph();
  restoreTiers();
});

describe("unit · onInvalidate: 'purge' takes the page down", () => {
  test("the default is 'stale': a bust answers the old copy once more", async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>published</p>');
    controller.revalidateByTags([postTag]);
    const next = await controller.serve(key, () => ({ html: '<p>gone</p>', status: 404 }));
    expect(next.state).toBe('stale');
    expect(next.result.body).toBe('<p>published</p>');
  });

  test('a bust DELETES the entry: the next request renders, waits, and never sees the old copy', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>published</p>');

    expect(controller.revalidateByTags([postTag])).toEqual([key]);
    expect(controller.store().get(key)).toBeUndefined();

    const next = await controller.serve(key, () => ({ html: '<p>gone</p>', status: 404 }));
    expect(next.state).toBe('miss');
    expect(next.result.status).toBe(404);
    expect(next.result.body).toBe('<p>gone</p>');
  });

  test('every stored key of the route goes: both locales, and every keyed query', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    isrRouteWith('apps/web/site/team/page.tsx', { tags: [teamTag], onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    const keys = [isrKeyIn('/blog/a'), isrKeyIn('/blog/a', 'es'), isrKeyIn('/blog/b?page=2')];
    for (const key of keys) await controller.serve(key, () => '<p>post</p>');
    await controller.serve(isrKeyIn('/team'), () => '<p>team</p>');

    controller.revalidateByTags([postTag]);
    expect(controller.store().paths()).toEqual([isrKeyIn('/team')]);
  });

  test('a stored 404 is purged like any page, so a published post is not a 404 for one more visitor', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/soon');
    await controller.serve(key, () => ({ html: '<p>nope</p>', status: 404 }));
    controller.revalidateByTags([postTag]);
    const next = await controller.serve(key, () => '<p>here now</p>');
    expect({ state: next.state, status: next.result.status }).toEqual({
      state: 'miss',
      status: 200,
    });
  });

  test('a render in flight when the purge lands is answered to its own request and not stored', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    const gate = Promise.withResolvers<undefined>();
    const first = controller.serve(key, async () => {
      await gate.promise;
      return '<p>read before the withdrawal</p>';
    });
    await Bun.sleep(0);
    controller.revalidateByTags([postTag]);
    gate.resolve(undefined);
    const answered = await first;
    expect(controller.store().get(key)).toBeUndefined();
    // Nor offered to the edge: the CDN's purge has already run, and this is the pre-purge page.
    expect(answered.result.headers['cache-control']).toBe('private, no-store');
    expect(answered.result.headers['surrogate-key']).toBeUndefined();
  });

  test('invalidateTags reaches it through the attached controller, and reports the purged keys', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    const detach = controller.attach();
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>published</p>');
    const report = await invalidateTags([postTag]);
    detach();
    expect(report.isr).toEqual([key]);
    expect(controller.store().get(key)).toBeUndefined();
  });

  test('a purge route tells a shared cache nothing may be served stale; the default still says a day', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    isrRouteWith('apps/web/site/team/page.tsx', { tags: [teamTag] });
    const controller = isrController({ routes: describePages });
    const post = await controller.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    const team = await controller.serve(isrKeyIn('/team'), () => '<p>t</p>');
    expect(post.result.headers['cache-control']).toBe('public, max-age=0, s-maxage=60');
    expect(team.result.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=86400',
    );
  });
});

describe('unit · a store two controllers share', () => {
  // The graph is one process's memory of what IT rendered. A replica answering a hit for an entry
  // another replica wrote had no edge for it, so a bust that arrived there found nothing to do.
  test('a purge on the controller that never rendered the page deletes it from the shared store', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const store = memoryIsrStore();
    // Each replica's graph is its own; `none` is a replica that registered nothing.
    const none = (): readonly string[] => [];
    const rendered = isrController({ store, routes: describePages, isrDependents: none });
    const other = isrController({ store, routes: describePages, isrDependents: none });
    const key = isrKeyIn('/blog/a');
    await rendered.serve(key, () => '<p>published</p>');
    expect((await other.serve(key, () => '<p>never called</p>')).state).toBe('hit');

    expect(other.revalidateByTags([postTag])).toEqual([key]);
    expect(store.get(key)).toBeUndefined();
    expect((await rendered.serve(key, () => '<p>gone</p>')).state).toBe('miss');
  });

  test("under 'stale' the controller that never rendered it marks the shared entry stale", async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const store = memoryIsrStore();
    const none = (): readonly string[] => [];
    const rendered = isrController({ store, routes: describePages, isrDependents: none });
    const other = isrController({ store, routes: describePages, isrDependents: none });
    const key = isrKeyIn('/blog/a');
    await rendered.serve(key, () => '<p>v1</p>');
    other.revalidateByTags([postTag]);
    expect(store.get(key)?.stale).toBe(true);
  });

  test('an entry that outlived the process that rendered it is still purged by its tag', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const store = memoryIsrStore();
    const key = isrKeyIn('/blog/a');
    store.set({
      path: key,
      html: '<p>old</p>',
      hash: 'h',
      generatedAt: 0,
      ttlMs: null,
      stale: false,
    });
    const controller = isrController({ store, routes: describePages });
    const detach = controller.attach();
    const report = await invalidateTags([tag('post', '1')]);
    detach();
    expect(report.isr).toEqual([key]);
    expect(store.get(key)).toBeUndefined();
  });

  test('a bust of a tag no route carries reads no store at all', async () => {
    isrRouteWith(POST, { tags: [postTag], onInvalidate: 'purge' });
    const inner = memoryIsrStore();
    let listed = 0;
    const store = {
      ...inner,
      paths: () => {
        listed += 1;
        return inner.paths();
      },
    };
    const controller = isrController({ store, routes: describePages });
    await controller.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    listed = 0;
    expect(controller.revalidateByTags([teamTag])).toEqual([]);
    expect(listed).toBe(0);
  });
});

describe('unit · maxStale bounds a copy served past its ttl', () => {
  test('inside the bound the stale copy answers; past it the request waits for a fresh render', async () => {
    isrRouteWith(POST, { ttl: '1m', maxStale: '10m' });
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>v1</p>');

    clock = 60_000 + 599_999;
    const inside = await controller.serve(key, () => '<p>v2</p>');
    expect(inside.state).toBe('stale');
    expect(inside.result.body).toBe('<p>v1</p>');
    await controller.regenerate(key, () => '<p>v2</p>');

    clock += 60_000 + 600_000;
    const past = await controller.serve(key, () => '<p>v3</p>');
    expect(past.state).toBe('miss');
    expect(past.result.body).toBe('<p>v3</p>');
  });

  test('with no maxStale a copy is served stale however old it is, as before', async () => {
    isrRouteWith(POST, { ttl: '1m' });
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>v1</p>');
    clock = 30 * 86_400_000;
    expect((await controller.serve(key, () => '<p>v2</p>')).state).toBe('stale');
  });

  test('a copy past the bound is not an answer even when its re-render fails', async () => {
    isrRouteWith(POST, { ttl: '1m', maxStale: '10m' });
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>v1</p>');
    clock = 86_400_000;
    const failed = await controller.serve(key, () => ({ html: '<p>down</p>', status: 503 }));
    expect({ state: failed.state, status: failed.result.status }).toEqual({
      state: 'miss',
      status: 503,
    });
  });

  test('the bound is what a shared cache is told it may serve stale for', async () => {
    isrRouteWith(POST, { ttl: '1m', maxStale: '10m' });
    const controller = isrController({ routes: describePages });
    const served = await controller.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    expect(served.result.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
  });
});
