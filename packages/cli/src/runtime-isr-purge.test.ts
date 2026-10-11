// `onInvalidate: 'purge'` over HTTP, through the real pipeline and the real fan-out: what the
// origin answers and what it tells the edge have to agree at every step of a withdrawal. Measured
// before this file: the CDN was purged FIRST, so a request between that purge and the origin's own
// delete was a public hit the edge cached again for a whole `s-maxage`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { PurgeDriver } from '@ultimat3/cache';
import {
  cdnTier,
  invalidateTags,
  isolateGraph,
  isolateTiers,
  registerTier,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute, withStatus } from '@ultimat3/render';
import { isrController, memoryIsrStore } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-purge-under-test';
const postTag = tag('post');
let published = true;
/** When set, `load` waits on it — a render that read its rows before the withdrawal. */
let gate: Promise<void> | undefined;

function registerArticle(onInvalidate: 'purge' | 'stale' = 'purge'): void {
  registerRoute({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    component: (props: { readonly data?: { readonly body?: string } }) =>
      h('p', {}, props.data?.body ?? ''),
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [postTag], ttl: '10m', onInvalidate, query: [] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: async () => {
        const was = published;
        if (gate !== undefined) await gate;
        return was ? { body: 'THE ARTICLE' } : withStatus(404, { body: 'no such article' });
      },
      meta: () => ({ title: 'Article', description: 'an isr article' }),
    }),
  });
}

const restoreGraph = isolateGraph();
const restoreTiers = isolateTiers();

afterEach(() => {
  clearRoutes();
  resetTiers();
  published = true;
  gate = undefined;
});

afterAll(() => {
  isrController().attach()();
  restoreGraph();
  restoreTiers();
});

function serving() {
  const { isr, release } = attachedIsr({ buildId: BUILD_ID });
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const get = (path = '/blog/a') => server.fetch(new Request(`http://dev.test${path}`));
  return { isr, release, get };
}

const edgeFacts = (response: Response) => ({
  status: response.status,
  cache: response.headers.get('cache-control'),
  keys: response.headers.get('surrogate-key'),
  stale: response.headers.get('x-ultimate-isr'),
});

const SHARED = { cache: 'public, max-age=0, s-maxage=600', keys: 'post e:post', stale: null };

describe('unit · a purge route, as the edge sees it', () => {
  test('stored pages carry their purge keys and no stale-while-revalidate, on the miss and on the hit', async () => {
    registerArticle();
    const { release, get } = serving();
    expect(edgeFacts(await get())).toEqual({ status: 200, ...SHARED });
    expect(edgeFacts(await get())).toEqual({ status: 200, ...SHARED });
    release();
  });

  test('the request after a withdrawal is the 404, rendered fresh — never the stored page once more', async () => {
    registerArticle();
    const { release, get } = serving();
    expect(await (await get()).text()).toContain('THE ARTICLE');
    published = false;
    await invalidateTags([postTag]);
    const next = await get();
    // A 4xx is stored by the origin and never offered to the edge: the pipeline's own rule
    // (`replayableExchange`), which strips the purge keys with the offer.
    expect(edgeFacts(next)).toEqual({ status: 404, cache: 'no-store', keys: null, stale: null });
    expect(await next.text()).not.toContain('THE ARTICLE');
    // Published again: the page is back on the next request, shareable, under its keys.
    published = true;
    await invalidateTags([postTag]);
    expect(edgeFacts(await get())).toEqual({ status: 200, ...SHARED });
    release();
  });

  test('the edge is purged only AFTER the origin stopped answering the page', async () => {
    registerArticle();
    const { isr, release, get } = serving();
    await get();
    const heldAtPurge: (readonly string[])[] = [];
    const edge: PurgeDriver = {
      name: 'spy',
      purge: (keys) => {
        heldAtPurge.push(isr.store().paths());
        return Promise.resolve(keys);
      },
      purgeAll: () => Promise.resolve(),
    };
    registerTier(cdnTier({ purge: edge }));
    published = false;
    await invalidateTags([postTag]);
    expect(heldAtPurge).toEqual([[]]);
    release();
  });

  test('a render that read its rows before the withdrawal is not offered to the edge, and the next request does not join it', async () => {
    registerArticle();
    const { release, get } = serving();
    const open = Promise.withResolvers<void>();
    gate = open.promise;
    const racing = get();
    await Bun.sleep(5);
    published = false;
    await invalidateTags([postTag]);
    gate = undefined;
    // Arrives AFTER the purge while the old render is still running: its own render, its own 404.
    const after = await get();
    expect(after.status).toBe(404);
    expect(await after.text()).not.toContain('THE ARTICLE');

    open.resolve();
    const before = await racing;
    expect(edgeFacts(before)).toMatchObject({ cache: 'private, no-store', keys: null });
    // And the late render did not put the article back.
    expect((await get()).status).toBe(404);
    release();
  });
});

describe('unit · a shared isrStore must be able to refuse a write', () => {
  const { tagFence: _none, ...unfenced } = memoryIsrStore();

  test('a store with no tagFence is refused at boot when a route purges, naming the route', () => {
    registerArticle('purge');
    expect(() => attachedIsr({ buildId: BUILD_ID, store: unfenced })).toThrow(
      expect.objectContaining({
        code: 'X_ROUTE_MODE_INVALID',
        cause: expect.stringContaining('apps/web/site/blog/[slug]/page.tsx'),
      }),
    );
  });

  test('the same store is accepted when no route purges, and a fenced one always is', () => {
    registerArticle('stale');
    attachedIsr({ buildId: BUILD_ID, store: unfenced }).release();
    clearRoutes();
    registerArticle('purge');
    attachedIsr({ buildId: BUILD_ID, store: memoryIsrStore() }).release();
  });
});
