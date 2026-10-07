// Navigation preload and the throttled install fill, in the emitted worker, executed: a navigation
// is answered from the request the browser made while the worker booted, and the precache is
// filled a few entries at a time so it does not compete with the visitor's first click.

import { describe, expect, test } from 'bun:test';
import { APP_UPDATE_MESSAGE } from '@ultimat3/core';
import { generateServiceWorker, PRECACHE_CONCURRENCY } from './service-worker';
import { config, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute, StrategyEnv } from './strategies';
import { fromNetwork, networkFirst } from './strategies';

const routes: readonly PwaRoute[] = [
  { path: '/about', surface: 'site', mode: 'static', offline: 'precache' },
  { path: '/news', surface: 'site', mode: 'ssr', offline: 'runtime' },
  { path: '/live', surface: 'app', mode: 'ssr', offline: 'network-only' },
];

const worker = (buildId = 'build-1') => {
  const sw = swHarness();
  sw.load(generateServiceWorker(routes, config, buildId).source);
  return sw;
};

const preloaded = (body: string, headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(body, { status: 200, headers }));

describe('navigation preload', () => {
  test('activation enables it', async () => {
    const sw = worker();
    await sw.activate();
    expect(sw.preloadEnabled()).toBe(1);
  });

  test('a browser without it still activates', async () => {
    const sw = swHarness();
    const source = generateServiceWorker(routes, config, 'build-1').source;
    // The same worker in a realm whose registration has no `navigationPreload`.
    sw.load(`self.registration={};${source}`);
    await sw.activate();
    expect(sw.messages).toHaveLength(1);
  });

  test.each(['/about', '/news', '/live'])(
    'a navigation to %s is answered by the preload: no second request leaves the worker',
    async (path) => {
      const sw = worker();
      const answer = await sw.respondNavigate(path, preloaded('preloaded'));
      expect(await answer.text()).toBe('preloaded');
      expect(sw.fetched).toEqual([]);
    },
  );

  test('the preloaded document is still the offline copy afterwards', async () => {
    const sw = worker();
    await sw.respondNavigate('/news', preloaded('preloaded'));
    sw.goOffline();
    expect(await (await sw.respondNavigate('/news')).text()).toBe('preloaded');
  });

  test('a preload that resolves empty, or rejects, falls back to the fetch', async () => {
    const sw = worker();
    const empty = await sw.respondNavigate('/news', Promise.resolve(undefined));
    expect(await empty.text()).toBe('bytes for /news');
    const failed = Promise.reject(new TypeError('preload cancelled'));
    failed.catch(() => undefined);
    const again = await sw.respondNavigate('/news', failed);
    expect(await again.text()).toBe('bytes for /news');
    expect(sw.fetched).toHaveLength(2);
  });

  test('a request that is not a navigation never reads the preload', async () => {
    const sw = worker();
    const answer = await sw.respond('/news', false, preloaded('preloaded'));
    await sw.settled();
    expect(await answer.text()).toBe('bytes for /news');
  });

  test('a preload answered by ANOTHER build tells the windows, and the worker stops stamping', async () => {
    const sw = worker('build-1');
    await sw.respondNavigate('/news', preloaded('new', { 'x-ultimate-build': 'build-2' }));
    await Bun.sleep(0);
    expect(sw.messages).toContainEqual({ type: APP_UPDATE_MESSAGE, to: 'build-2' });
    await sw.respondNavigate('/news');
    expect(sw.stamps).toEqual([null]);
  });

  test('a preload answered by this build says nothing', async () => {
    const sw = worker('build-1');
    await sw.respondNavigate('/news', preloaded('same', { 'x-ultimate-build': 'build-1' }));
    await Bun.sleep(0);
    expect(sw.messages).toEqual([]);
  });
});

describe('the strategy functions, the same rule', () => {
  const env = (fetched: string[]): StrategyEnv => ({
    open: async () => ({ match: async () => undefined, put: async () => undefined }),
    fetch: async (request) => {
      fetched.push(request.url);
      return new Response('network');
    },
  });

  test('network-first answers from the preload without a fetch', async () => {
    const fetched: string[] = [];
    const answer = await networkFirst(new Request('https://x.test/a'), env(fetched), {
      cacheName: 'test',
      preload: Promise.resolve(new Response('preloaded')),
    });
    expect(await answer.text()).toBe('preloaded');
    expect(fetched).toEqual([]);
  });

  test('an empty or rejected preload is a fetch', async () => {
    const fetched: string[] = [];
    const request = new Request('https://x.test/a');
    await fromNetwork(request, env(fetched), { preload: Promise.resolve(undefined) });
    await fromNetwork(request, env(fetched), { preload: Promise.reject(new TypeError('gone')) });
    expect(fetched).toHaveLength(2);
  });
});

describe('the install fill', () => {
  const many: readonly PwaRoute[] = Array.from({ length: 20 }, (_, i) => ({
    path: `/p${String(i).padStart(2, '0')}`,
    surface: 'site' as const,
    mode: 'static' as const,
    offline: 'precache' as const,
  }));

  test(`never has more than ${PRECACHE_CONCURRENCY} requests in flight, and fills every entry`, async () => {
    const sw = swHarness();
    const output = generateServiceWorker(many, config, 'build-1');
    sw.load(output.source);
    sw.slowNetwork();
    await sw.install();
    expect(sw.maxInFlight()).toBe(PRECACHE_CONCURRENCY);
    expect(sw.fetched).toHaveLength(output.precache.entries.length);
    expect(sw.caches.get('x-precache-build-1')?.entries.size).toBe(output.precache.entries.length);
  });

  test('one entry failing still costs that entry only', async () => {
    const sw = swHarness();
    const output = generateServiceWorker(many, config, 'build-1');
    sw.load(output.source);
    sw.answerWith((request) =>
      new URL(request.url).pathname === '/p03' ? new Response('gone', { status: 404 }) : undefined,
    );
    await sw.install();
    expect(sw.caches.get('x-precache-build-1')?.entries.size).toBe(
      output.precache.entries.length - 1,
    );
  });
});
