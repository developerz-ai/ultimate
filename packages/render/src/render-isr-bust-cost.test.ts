// What a generation and a bust cost the store (plan 101 slice 14 bug hunt). Over a shared disk
// every store call is a round trip, so: a bust reads no page back and touches no recency; a
// generation lists the store only when a new path could have pushed one out; and a listing that
// fails never turns a render that succeeded into a rejection.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';
import type { IsrStore } from './render-isr-store';
import { memoryIsrStore } from './render-isr-store';

const postTag: CacheTag = tag('post');
const teamTag: CacheTag = tag('team');
const POST = 'apps/web/site/blog/[slug]/page.tsx';
const TEAM = 'apps/web/site/team/page.tsx';

const restoreGraph = isolateGraph();
beforeEach(() => {
  clearRoutes();
  resetGraph();
});
afterAll(() => {
  clearRoutes();
  restoreGraph();
});

/** A memory store whose `get` and `paths` are counted, and whose `paths` can be made to fail. */
function countingStore(maxEntries?: number) {
  const inner = memoryIsrStore(maxEntries === undefined ? {} : { maxEntries });
  const calls = { get: 0, paths: 0, failPaths: false };
  const store: IsrStore = {
    ...inner,
    get: (path) => {
      calls.get += 1;
      return inner.get(path);
    },
    paths: () => {
      calls.paths += 1;
      if (calls.failPaths) return Promise.reject(new RangeError('the disk is down'));
      return inner.paths();
    },
  };
  return { inner, store, calls };
}

describe('a bust', () => {
  test('marks a held page without making it the most recently used', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    isrRouteWith(TEAM, { tags: [teamTag] });
    const store = memoryIsrStore({ maxEntries: 2 });
    const ctl = isrController({ store, routes: describePages });
    await ctl.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    await ctl.serve(isrKeyIn('/team'), () => '<p>team</p>');
    await ctl.revalidateByTags([postTag]);
    await ctl.serve(isrKeyIn('/blog/b'), () => '<p>b</p>');
    // `/blog/a` was used least recently: the bust read it back and made it the newest.
    expect(store.paths()).toEqual([isrKeyIn('/blog/b'), isrKeyIn('/team')].sort());
  });

  test('reads no page back from the store', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const { store, calls } = countingStore();
    const ctl = isrController({ store, routes: describePages });
    await ctl.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    await ctl.serve(isrKeyIn('/blog/b'), () => '<p>b</p>');
    calls.get = 0;
    expect(await ctl.revalidateByTags([postTag])).toHaveLength(2);
    expect(calls.get).toBe(0);
  });
});

describe('a generation', () => {
  test('lists the store only when a new path could have evicted one', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const { store, calls } = countingStore();
    const ctl = isrController({ store, routes: describePages });
    const key = isrKeyIn('/blog/a');
    await ctl.serve(key, () => '<p>v1</p>');
    calls.paths = 0;
    await ctl.regenerate(key, () => '<p>v2</p>');
    await ctl.regenerate(key, () => '<p>v3</p>');
    expect(calls.paths).toBe(0);
  });

  test('still forgets a path the store evicted', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const { inner, store } = countingStore(1);
    const ctl = isrController({ store, routes: describePages });
    await ctl.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    await ctl.serve(isrKeyIn('/blog/b'), () => '<p>b</p>');
    expect(inner.paths()).toEqual([isrKeyIn('/blog/b')]);
    expect(await ctl.revalidateByTags([postTag])).toEqual([isrKeyIn('/blog/b')]);
  });

  test('a listing that fails after the page was kept does not fail the render', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const { store, calls } = countingStore();
    const ctl = isrController({ store, routes: describePages });
    calls.failPaths = true;
    const served = await ctl.serve(isrKeyIn('/blog/a'), () => '<p>a</p>');
    expect([served.state, served.result.body]).toEqual(['miss', '<p>a</p>']);
  });
});
