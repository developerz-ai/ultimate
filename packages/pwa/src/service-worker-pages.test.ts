// A per-member document through the emitted worker: never from cache online, partitioned offline.

import { describe, expect, test } from 'bun:test';
import { generateServiceWorker } from './service-worker';
import { config, SW_ORIGIN, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute } from './strategies';

/**
 * A document rendered for ONE member — `stream`, or a gated `ssr` page — carries
 * `x-ultimate-scope` and `private`. The pages cache was keyed by URL alone, so on a shared browser
 * `/feed` rendered for kenji was answered to bruno from cache (stale-while-revalidate). A private
 * document is never served from cache while the network answers, and offline only the most recent
 * member's own pages answer.
 */
describe('a per-member document on a shared browser', () => {
  const feedRoutes: readonly PwaRoute[] = [
    { path: '/feed', surface: 'app', mode: 'stream', offline: 'runtime' },
    { path: '/about', surface: 'site', mode: 'isr', offline: 'runtime' },
  ];

  function signedIn(sw: ReturnType<typeof swHarness>) {
    let who = 'kenji';
    sw.answerWith((request) => {
      if (new URL(request.url).pathname !== '/feed') return undefined;
      return new Response(`feed for ${who}`, {
        headers: { 'cache-control': 'private, no-store', 'x-ultimate-scope': `scope-${who}` },
      });
    });
    return {
      as: (next: string): void => {
        who = next;
      },
    };
  }

  test('the second member never gets the first member’s document while online', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    const member = signedIn(sw);
    expect(await (await sw.request('/feed')).text()).toBe('feed for kenji');
    member.as('bruno');
    expect(await (await sw.request('/feed')).text()).toBe('feed for bruno');
  });

  test('offline, only the most recent member’s own page answers', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    const member = signedIn(sw);
    await sw.request('/feed');
    member.as('bruno');
    await sw.request('/feed');
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).toBe('feed for bruno');
    const partitions = [...sw.caches.keys()].filter((name) => name.includes('~'));
    expect(partitions).toHaveLength(1);
  });

  test.each(['private', 'max-age=0, private', 'no-cache, no-store'])(
    'a private document with no scope header is never stored at all: %s',
    async (control) => {
      const sw = swHarness();
      sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
      sw.answerWith(() => new Response('mine', { headers: { 'cache-control': control } }));
      await sw.request('/feed');
      sw.goOffline();
      expect(await (await sw.request('/feed')).text()).not.toBe('mine');
    },
  );

  test('a shareable page keeps its strategy — served from cache while revalidating', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    await sw.request('/about');
    sw.goOffline();
    expect(await (await sw.request('/about')).text()).toBe('bytes for /about');
  });

  test('the activate warm-up stores a member’s page in that member’s partition', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    signedIn(sw);
    sw.openWindows(`${SW_ORIGIN}/feed`);
    await sw.activate();
    // The warm-up runs AFTER activation, on purpose (see the stream test below): let its fetch
    // leave while the network is still up, then cut it. The offline read waits for the rest.
    await Bun.sleep(10);
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).toBe('feed for kenji');
    expect([...sw.caches.keys()].filter((name) => name.includes('~'))).toHaveLength(1);
  });
});
