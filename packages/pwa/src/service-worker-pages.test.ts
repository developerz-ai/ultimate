// A per-member document through the emitted worker: never from cache online, never stored at all,
// and a page cache the app can empty on sign-out.

import { describe, expect, test } from 'bun:test';
import type { ServiceWorkerConfig } from './service-worker';
import { generateServiceWorker } from './service-worker';
import { config, SW_ORIGIN, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute, StrategyName } from './strategies';

/**
 * A document rendered for ONE member — `stream`, or a gated `ssr` page — carries
 * `x-ultimate-scope` and `private, no-store`. It was kept in a per-principal partition for offline,
 * so after sign-out an offline navigation on a shared device showed the previous member's cases
 * (notificado.co, 22.3.2). `no-store` means what it says: the worker stores none of it, under any
 * rule, and a route the author did not mark personal is caught by the response instead.
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

  const storedBodies = async (sw: ReturnType<typeof swHarness>): Promise<string[]> => {
    const bodies: string[] = [];
    for (const cache of sw.caches.values()) {
      for (const response of cache.entries.values()) bodies.push(await response.clone().text());
    }
    return bodies;
  };

  test('the second member never gets the first member’s document while online', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    const member = signedIn(sw);
    expect(await (await sw.request('/feed')).text()).toBe('feed for kenji');
    member.as('bruno');
    expect(await (await sw.request('/feed')).text()).toBe('feed for bruno');
  });

  test('offline, no member’s page answers — the offline document does', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    const member = signedIn(sw);
    await sw.request('/feed');
    member.as('bruno');
    await sw.request('/feed');
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).not.toContain('feed for');
    expect(await storedBodies(sw)).not.toContain('feed for bruno');
    expect([...sw.caches.keys()].filter((name) => name.includes('~'))).toEqual([]);
  });

  test.each(['private', 'max-age=0, private', 'no-cache, no-store', 'No-Store'])(
    'a private document is never stored at all: %s',
    async (control) => {
      const sw = swHarness();
      sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
      sw.answerWith(() => new Response('mine', { headers: { 'cache-control': control } }));
      await sw.request('/feed');
      sw.goOffline();
      expect(await (await sw.request('/feed')).text()).not.toBe('mine');
      expect(await storedBodies(sw)).not.toContain('mine');
    },
  );

  test.each<StrategyName>(['cache-first', 'network-first', 'stale-while-revalidate'])(
    'whatever the rule says — %s stores no no-store response either',
    async (strategy) => {
      const sw = swHarness();
      const routes: readonly PwaRoute[] = [
        { path: '/mine', surface: 'site', mode: 'static', offline: 'runtime', strategy },
      ];
      sw.load(generateServiceWorker(routes, config, 'build-1').source);
      let calls = 0;
      sw.answerWith(() => {
        calls += 1;
        return new Response(`mine ${calls}`, { headers: { 'cache-control': 'no-store' } });
      });
      expect(await (await sw.request('/mine')).text()).toBe('mine 1');
      // Online again: nothing was kept, so the network answers the second time too.
      expect(await (await sw.request('/mine')).text()).toBe('mine 2');
      expect(await storedBodies(sw)).toEqual([]);
    },
  );

  test('nor does the precache cache a no-store answer a precached route got at runtime', async () => {
    const sw = swHarness();
    const routes: readonly PwaRoute[] = [
      { path: '/', surface: 'site', mode: 'static', offline: 'precache' },
    ];
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    sw.answerWith(
      () => new Response('signed-in home', { headers: { 'cache-control': 'no-store' } }),
    );
    await sw.request('/');
    expect(await storedBodies(sw)).toEqual([]);
  });

  test('a shareable page keeps its strategy — served from cache offline', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    await sw.request('/about');
    sw.goOffline();
    expect(await (await sw.request('/about')).text()).toBe('bytes for /about');
  });

  test('the activate warm-up stores no member’s page either', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(feedRoutes, config, 'build-1').source);
    signedIn(sw);
    sw.openWindows(`${SW_ORIGIN}/feed`);
    await sw.activate();
    await Bun.sleep(10);
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).not.toBe('feed for kenji');
    expect(await storedBodies(sw)).toEqual([]);
  });
});

/**
 * `pwa.offline.personalPages: 'last-member'` — 21.0.0's offline-first mode, for an app that declares
 * it (and clears on sign-out): never from cache online, the most recent member's own copy offline.
 */
describe("personalPages: 'last-member'", () => {
  const lastMember: ServiceWorkerConfig = {
    ...config,
    offline: { ...config.offline, personalPages: 'last-member' },
  };
  const routes: readonly PwaRoute[] = [
    { path: '/feed', surface: 'app', mode: 'stream', offline: 'runtime', personal: true },
  ];

  const as = (sw: ReturnType<typeof swHarness>, who: () => string): void =>
    sw.answerWith(
      () =>
        new Response(`feed for ${who()}`, {
          headers: { 'cache-control': 'private, no-store', 'x-ultimate-scope': `scope-${who()}` },
        }),
    );

  test('routes a personal page by its mode, not network-only', () => {
    const source = generateServiceWorker(routes, lastMember, 'build-1').source;
    expect(source).toContain('{"p":"^/feed/?$","s":"networkFirst","c":"pages"}');
  });

  test('never answers from cache online, and offline answers the most recent member only', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, lastMember, 'build-1').source);
    let who = 'kenji';
    as(sw, () => who);
    expect(await (await sw.request('/feed')).text()).toBe('feed for kenji');
    who = 'bruno';
    expect(await (await sw.request('/feed')).text()).toBe('feed for bruno');
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).toBe('feed for bruno');
    expect([...sw.caches.keys()].filter((name) => name.includes('~'))).toHaveLength(1);
  });

  test('clear-pages empties the partition, so sign-out leaves nothing behind', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, lastMember, 'build-1').source);
    as(sw, () => 'kenji');
    await sw.request('/feed');
    await sw.message({ type: 'clear-pages' });
    sw.goOffline();
    expect(await (await sw.request('/feed')).text()).not.toBe('feed for kenji');
  });

  test('still never precaches a personal page', () => {
    const precached = generateServiceWorker(
      [{ path: '/panel', surface: 'app', mode: 'ssr', offline: 'precache', personal: true }],
      lastMember,
      'build-1',
    ).precache.entries.map((entry) => entry.url);
    expect(precached).not.toContain('/panel');
  });
});

/**
 * Sign-out is the app's moment, not the worker's: `{ type: 'clear-pages' }` from the page empties
 * every build's pages cache — including a 22.3.2 worker's per-member partitions — so a document the
 * app thought shareable is not the next person's offline answer either.
 */
describe('the clear-pages message', () => {
  const routes: readonly PwaRoute[] = [
    { path: '/about', surface: 'site', mode: 'isr', offline: 'runtime' },
    { path: '/', surface: 'site', mode: 'static', offline: 'precache' },
  ];

  test('empties the pages caches, so offline answers the offline document', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    await sw.request('/about');
    // A 22.3.2 worker's per-member partition, left behind by an earlier build.
    sw.caches.set('x-pages-build-0~scope-kenji', sw.caches.get('x-pages-build-1') ?? never());
    await sw.message({ type: 'clear-pages' });
    expect([...sw.caches.keys()].filter((name) => name.startsWith('x-pages-'))).toEqual([]);
    sw.goOffline();
    expect(await (await sw.request('/about')).text()).not.toBe('bytes for /about');
  });

  test('leaves the precache alone — the marketing pages still answer offline', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    await sw.install();
    await sw.message({ type: 'clear-pages' });
    sw.goOffline();
    expect(await (await sw.request('/')).text()).toBe('bytes for /');
  });

  test('answers the window that asked, so a sign-out can wait for it', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    const replies: unknown[] = [];
    await sw.message({ type: 'clear-pages' }, (data) => replies.push(data));
    expect(replies).toEqual([{ type: 'pages-cleared' }]);
  });
});

function never(): never {
  return expect.unreachable('the pages cache was not opened');
}
