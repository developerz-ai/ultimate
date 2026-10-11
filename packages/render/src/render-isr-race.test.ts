// A purge against a render that is already running. Each test is a race held open by a deferred
// promise, never a sleep. The fence alone only stops the pre-purge render from being STORED: a
// request arriving AFTER the purge joined that render and was answered the withdrawn page, and a
// second replica — which has its own fence — wrote the withdrawn page back into a shared store.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags, isolateGraph, isolateTiers, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';
import { memoryIsrStore } from './render-isr-store';
import type { IsrFence } from './render-isr-types';

const postTag: CacheTag = tag('post');
const POST = 'apps/web/site/blog/[slug]/page.tsx';
const PURGE = { tags: [postTag], ttl: '10m', onInvalidate: 'purge' } as const;
const WITHDRAWN = '<p>WITHDRAWN</p>';
const gone = () => ({ html: '<p>gone</p>', status: 404 });

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

/** A render a test finishes by hand: it read its rows before whatever the test does next. */
function heldRender(html: string) {
  const gate = Promise.withResolvers<undefined>();
  let started = false;
  return {
    render: async () => {
      started = true;
      await gate.promise;
      return html;
    },
    started: () => started,
    release: () => gate.resolve(undefined),
  };
}

describe('unit · a request after the purge never joins a render from before it', () => {
  test('a miss render in flight: the next request leads its own render', async () => {
    isrRouteWith(POST, PURGE);
    const controller = isrController({ routes: describePages });
    const detach = controller.attach();
    const key = isrKeyIn('/blog/a');
    const before = heldRender(WITHDRAWN);
    const first = controller.serve(key, before.render);
    await Bun.sleep(0);
    expect(before.started()).toBe(true);

    await invalidateTags([postTag]);
    const after = await controller.serve(key, gone);
    expect(after.result.body).toBe('<p>gone</p>');
    expect(after.result.status).toBe(404);

    before.release();
    expect((await first).result.headers['cache-control']).toBe('private, no-store');
    // The late pre-purge render did not replace the page rendered after it.
    expect(controller.store().get(key)?.html).toBe('<p>gone</p>');
    detach();
  });

  test('a background regeneration of a ttl-stale page in flight: the next request leads its own render', async () => {
    isrRouteWith(POST, { ...PURGE, maxStale: '1h' });
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const detach = controller.attach();
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>v1</p>');
    clock = 601_000;
    const before = heldRender(WITHDRAWN);
    expect((await controller.serve(key, before.render)).state).toBe('stale');
    await Bun.sleep(0);
    expect(before.started()).toBe(true);

    await invalidateTags([postTag]);
    const after = await controller.serve(key, gone);
    expect({ state: after.state, body: after.result.body }).toEqual({
      state: 'miss',
      body: '<p>gone</p>',
    });
    before.release();
    await Bun.sleep(0);
    expect(controller.store().get(key)?.html).toBe('<p>gone</p>');
    detach();
  });

  test('a request that had already JOINED the render is not answered it either', async () => {
    isrRouteWith(POST, PURGE);
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    const before = heldRender(WITHDRAWN);
    const leader = controller.serve(key, before.render);
    await Bun.sleep(0);
    const joiner = controller.serve(key, gone);
    controller.revalidateByTags([postTag]);
    before.release();
    await leader;
    expect((await joiner).result.body).toBe('<p>gone</p>');
  });

  test('revalidateByTags reaches a cold page in neither the graph nor the store', async () => {
    isrRouteWith(POST, PURGE);
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    const before = heldRender(WITHDRAWN);
    const first = controller.serve(key, before.render);
    await Bun.sleep(0);
    // Another page of the route finishes: its reconciliation must not forget the page in flight.
    await controller.serve(isrKeyIn('/blog/b'), () => '<p>b</p>');

    expect(controller.revalidateByTags([postTag])).toContain(isrKeyIn('/blog/b'));
    const after = await controller.serve(key, gone);
    expect(after.result.body).toBe('<p>gone</p>');
    before.release();
    const answered = await first;
    expect(answered.result.headers['cache-control']).toBe('private, no-store');
    expect(controller.store().get(key)?.html).toBe('<p>gone</p>');
  });
});

describe('unit · two replicas, two fences, one store', () => {
  /** A replica that has not heard the bust: its process-local fence still says "valid". */
  const deaf: IsrFence = {
    sample: () => ({ isValid: () => true, cover: () => undefined }),
    mark: () => undefined,
  };
  const none = (): readonly string[] => [];

  test('a render that began before the purge on ANOTHER replica cannot write the page back', async () => {
    isrRouteWith(POST, PURGE);
    const store = memoryIsrStore();
    const purging = isrController({ store, routes: describePages, isrDependents: none });
    const other = isrController({ store, routes: describePages, isrDependents: none, fence: deaf });
    const key = isrKeyIn('/blog/a');
    await purging.serve(key, () => WITHDRAWN);

    // The other replica's copy went stale by its clock and it is re-rendering — from old rows.
    const before = heldRender(WITHDRAWN);
    const racing = other.regenerate(key, before.render);
    await Bun.sleep(0);

    purging.revalidateByTags([postTag]);
    expect(store.get(key)).toBeUndefined();
    before.release();
    await racing;
    expect(store.get(key)).toBeUndefined();

    // And a render that begins AFTER the purge is stored as usual.
    await other.regenerate(key, gone);
    expect(store.get(key)?.status).toBe(404);
  });

  test('a store with NO fence of its own is re-filled — which is why a boot refuses one', async () => {
    isrRouteWith(POST, PURGE);
    const { tagFence: _none, ...unfenced } = memoryIsrStore();
    const purging = isrController({ store: unfenced, routes: describePages, isrDependents: none });
    const other = isrController({
      store: unfenced,
      routes: describePages,
      isrDependents: none,
      fence: deaf,
    });
    const key = isrKeyIn('/blog/a');
    await purging.serve(key, () => WITHDRAWN);
    const before = heldRender(WITHDRAWN);
    const racing = other.regenerate(key, before.render);
    await Bun.sleep(0);
    purging.revalidateByTags([postTag]);
    before.release();
    await racing;
    expect(unfenced.get(key)?.html).toBe(WITHDRAWN);
  });

  test("under 'stale' too: the other replica cannot overwrite the stale mark with pre-bust content", async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const store = memoryIsrStore();
    const busting = isrController({ store, routes: describePages, isrDependents: none });
    const other = isrController({ store, routes: describePages, isrDependents: none, fence: deaf });
    const key = isrKeyIn('/blog/a');
    await busting.serve(key, () => '<p>v1</p>');
    const before = heldRender('<p>v1 again</p>');
    const racing = other.regenerate(key, before.render);
    await Bun.sleep(0);
    busting.revalidateByTags([postTag]);
    before.release();
    await racing;
    expect(store.get(key)).toMatchObject({ html: '<p>v1</p>', stale: true });
  });
});
