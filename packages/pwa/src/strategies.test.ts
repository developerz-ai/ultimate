import { describe, expect, test } from 'bun:test';
import type {
  PwaRenderMode,
  PwaRoute,
  StrategyCache,
  StrategyEnv,
  StrategyName,
} from './strategies';
import {
  cacheFirst,
  MODE_STRATEGY,
  networkFirst,
  STRATEGY_FN_NAMES,
  STRATEGY_NAMES,
  STRATEGY_SOURCE,
  strategyFor,
} from './strategies';

function route(partial: Partial<PwaRoute> & { mode: PwaRenderMode }): PwaRoute {
  return {
    path: '/x',
    surface: 'app',
    offline: 'runtime',
    ...partial,
  };
}

function fakeEnv(seed: Map<string, Response>, network: () => Promise<Response>): StrategyEnv {
  const cache: StrategyCache = {
    match: async (request) => seed.get(request.url),
    put: async (request, response) => {
      seed.set(request.url, response);
    },
  };
  return { open: async () => cache, fetch: network };
}

describe('render mode → strategy', () => {
  test.each<[PwaRenderMode, StrategyName]>([
    ['static', 'cache-first'],
    ['isr', 'stale-while-revalidate'],
    ['ssr', 'network-first'],
    ['stream', 'stale-while-revalidate'],
    ['spa', 'cache-first'],
  ])('%s → %s', (mode, expected) => {
    expect(MODE_STRATEGY[mode]).toBe(expected);
    expect(strategyFor(route({ mode }))).toBe(expected);
  });

  test("offline: 'network-only' overrides the mode default", () => {
    expect(strategyFor(route({ mode: 'static', offline: 'network-only' }))).toBe('network-only');
  });

  test('an explicit per-route strategy wins over everything', () => {
    expect(
      strategyFor(route({ mode: 'ssr', offline: 'network-only', strategy: 'cache-first' })),
    ).toBe('cache-first');
  });

  test('every strategy has emitted source and a stable function name', () => {
    for (const name of STRATEGY_NAMES) {
      expect(STRATEGY_SOURCE[name]).toContain(STRATEGY_FN_NAMES[name]);
    }
  });
});

describe('strategy behaviour', () => {
  test('cache-first answers from the cache without touching the network', async () => {
    const seed = new Map([['https://x.test/a', new Response('cached')]]);
    let fetched = 0;
    const env = fakeEnv(seed, async () => {
      fetched += 1;
      return new Response('network');
    });

    const response = await cacheFirst(new Request('https://x.test/a'), env, {
      cacheName: 'test',
    });
    expect(await response.text()).toBe('cached');
    expect(fetched).toBe(0);
  });

  test('network-first falls back to the cache when the network fails', async () => {
    const seed = new Map([['https://x.test/b', new Response('cached')]]);
    const env = fakeEnv(seed, () => Promise.reject(new Error('offline')));

    const response = await networkFirst(new Request('https://x.test/b'), env, {
      cacheName: 'test',
    });
    expect(await response.text()).toBe('cached');
  });

  test('network-first surfaces the offline fallback when nothing is cached', async () => {
    const env = fakeEnv(new Map(), () => Promise.reject(new Error('offline')));
    const response = await networkFirst(new Request('https://x.test/c'), env, {
      cacheName: 'test',
      fallback: async () => new Response('offline page', { status: 200 }),
    });
    expect(await response.text()).toBe('offline page');
  });
});
