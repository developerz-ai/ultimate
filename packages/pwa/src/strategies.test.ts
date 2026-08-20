import { describe, expect, test } from 'bun:test';
import { PwaStrategyExhaustedError } from './errors';
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
  networkOnly,
  STRATEGY_FN_NAMES,
  STRATEGY_FNS,
  STRATEGY_NAMES,
  STRATEGY_SOURCE,
  staleWhileRevalidate,
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

/**
 * The three paths a cache miss can end on. `fetchAndStore` is private, so it is reached the only
 * way an app reaches it — through `cacheFirst` with nothing in the cache.
 */
describe('cache-first on a miss', () => {
  test('stores what it fetched, so the second visit never asks the network again', async () => {
    const seed = new Map<string, Response>();
    let fetched = 0;
    const env = fakeEnv(seed, async () => {
      fetched += 1;
      return new Response('network');
    });

    const first = await cacheFirst(new Request('https://x.test/d'), env, { cacheName: 'test' });
    expect(await first.text()).toBe('network');
    expect(fetched).toBe(1);

    const second = await cacheFirst(new Request('https://x.test/d'), env, { cacheName: 'test' });
    expect(await second.text()).toBe('network');
    expect(fetched).toBe(1);
  });

  test('a non-200 is answered but never cached — an error page must not become the page', async () => {
    const seed = new Map<string, Response>();
    const env = fakeEnv(seed, async () => new Response('nope', { status: 404 }));

    const response = await cacheFirst(new Request('https://x.test/e'), env, { cacheName: 'test' });
    expect(response.status).toBe(404);
    expect(seed.has('https://x.test/e')).toBe(false);
  });

  test('serves the offline fallback when the network is dead', async () => {
    const env = fakeEnv(new Map(), () => Promise.reject(new TypeError('offline')));
    const response = await cacheFirst(new Request('https://x.test/f'), env, {
      cacheName: 'test',
      fallback: async () => new Response('offline page'),
    });
    expect(await response.text()).toBe('offline page');
  });

  test('rethrows the network failure when no fallback was configured', async () => {
    const env = fakeEnv(new Map(), () => Promise.reject(new TypeError('offline')));
    await expect(
      cacheFirst(new Request('https://x.test/g'), env, { cacheName: 'test' }),
    ).rejects.toThrow('offline');
  });
});

describe('stale-while-revalidate', () => {
  test('answers the stale copy first and writes the fresh one behind it', async () => {
    const seed = new Map([['https://x.test/h', new Response('stale')]]);
    let stored: (value: string) => void = () => undefined;
    const written = new Promise<string>((resolve) => {
      stored = resolve;
    });
    const cache: StrategyCache = {
      match: async (request) => seed.get(request.url),
      put: async (request, response) => {
        seed.set(request.url, response);
        stored(await response.text());
      },
    };
    const env: StrategyEnv = {
      open: async () => cache,
      fetch: async () => new Response('fresh'),
    };

    const response = await staleWhileRevalidate(new Request('https://x.test/h'), env, {
      cacheName: 'test',
    });
    // The user gets the stale bytes — the refresh is behind the response, not in front of it.
    expect(await response.text()).toBe('stale');
    expect(await written).toBe('fresh');
  });

  test('with nothing cached it waits for the network rather than answering empty', async () => {
    const seed = new Map<string, Response>();
    const env = fakeEnv(seed, async () => new Response('fresh'));

    const response = await staleWhileRevalidate(new Request('https://x.test/i'), env, {
      cacheName: 'test',
    });
    expect(await response.text()).toBe('fresh');
    expect(seed.has('https://x.test/i')).toBe(true);
  });

  test('a dead network with nothing cached and no fallback is X_PWA_STRATEGY_EXHAUSTED', async () => {
    const env = fakeEnv(new Map(), () => Promise.reject(new TypeError('offline')));
    await expect(
      staleWhileRevalidate(new Request('https://x.test/j'), env, { cacheName: 'pages' }),
    ).rejects.toMatchObject({ code: PwaStrategyExhaustedError.code });
  });

  test('a dead network with nothing cached uses the fallback when there is one', async () => {
    const env = fakeEnv(new Map(), () => Promise.reject(new TypeError('offline')));
    const response = await staleWhileRevalidate(new Request('https://x.test/k'), env, {
      cacheName: 'pages',
      fallback: async () => new Response('offline page'),
    });
    expect(await response.text()).toBe('offline page');
  });
});

describe('network-only', () => {
  /** Opening a cache at all would break the declaration `network-only` makes. */
  function uncachedEnv(network: () => Promise<Response>): StrategyEnv {
    return {
      open: (): Promise<StrategyCache> => {
        expect.unreachable('network-only opened a cache');
      },
      fetch: network,
    };
  }

  test('never opens a cache', async () => {
    const response = await networkOnly(
      new Request('https://x.test/l'),
      uncachedEnv(async () => new Response('live')),
      { cacheName: 'test' },
    );
    expect(await response.text()).toBe('live');
  });

  test('falls back when the network fails, and rethrows without a fallback', async () => {
    const env = uncachedEnv(() => Promise.reject(new TypeError('offline')));

    const response = await networkOnly(new Request('https://x.test/m'), env, {
      cacheName: 'test',
      fallback: async () => new Response('offline page'),
    });
    expect(await response.text()).toBe('offline page');

    await expect(
      networkOnly(new Request('https://x.test/n'), env, { cacheName: 'test' }),
    ).rejects.toThrow('offline');
  });
});

describe('STRATEGY_FNS', () => {
  test('every name dispatches to the function of that name, and to no other', () => {
    expect(Object.keys(STRATEGY_FNS).sort()).toEqual([...STRATEGY_NAMES].sort());
    expect(STRATEGY_FNS['cache-first']).toBe(cacheFirst);
    expect(STRATEGY_FNS['network-first']).toBe(networkFirst);
    expect(STRATEGY_FNS['stale-while-revalidate']).toBe(staleWhileRevalidate);
    expect(STRATEGY_FNS['network-only']).toBe(networkOnly);
  });
});
