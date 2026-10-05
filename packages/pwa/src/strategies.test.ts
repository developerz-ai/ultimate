import { describe, expect, test } from 'bun:test';
import type { RenderMode } from '@ultimat3/core';
import { PwaStrategyExhaustedError } from './errors';
import type { PwaRoute, StrategyCache, StrategyEnv, StrategyName } from './strategies';
import {
  cacheFirst,
  MODE_STRATEGY,
  NETWORK_SOURCE,
  networkFirst,
  networkOnly,
  STRATEGY_FN_NAMES,
  STRATEGY_FNS,
  STRATEGY_NAMES,
  STRATEGY_SOURCE,
  staleWhileRevalidate,
  strategyFor,
} from './strategies';

function route(partial: Partial<PwaRoute> & { mode: RenderMode }): PwaRoute {
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

describe('a page rendered for someone', () => {
  // A per-member page kept for offline answered the PREVIOUS member's data on a shared device after
  // sign-out (notificado.co, /casos under networkFirst). Personal means never cached.
  test.each<RenderMode>(['static', 'isr', 'ssr', 'stream'])(
    'is network-only whatever its %s render mode says',
    (mode) => {
      expect(strategyFor(route({ mode, personal: true }))).toBe('network-only');
      expect(strategyFor(route({ mode, offline: 'precache', personal: true }))).toBe(
        'network-only',
      );
    },
  );

  test('an explicit per-route strategy is still the override', () => {
    expect(strategyFor(route({ mode: 'ssr', personal: true, strategy: 'network-first' }))).toBe(
      'network-first',
    );
  });
});

describe('render mode → strategy', () => {
  // Every rule is a DOCUMENT, and a document online is the network's. `static` was `cache-first`
  // and `isr`/`stream` `stale-while-revalidate`, so an online navigation got the HTML the old
  // worker held — the previous deploy, linking the previous deploy's hashed assets — until the
  // visitor pressed Shift+F5 (22.3.1, notificado.co).
  test.each<[RenderMode, StrategyName]>([
    ['static', 'network-first'],
    ['isr', 'network-first'],
    ['ssr', 'network-first'],
    ['stream', 'network-first'],
  ])('%s → %s', (mode, expected) => {
    expect(MODE_STRATEGY[mode]).toBe(expected);
    expect(strategyFor(route({ mode }))).toBe(expected);
  });

  test('a static precached site page is network-first — the precache is its offline copy only', () => {
    expect(strategyFor(route({ mode: 'static', surface: 'site', offline: 'precache' }))).toBe(
      'network-first',
    );
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

/**
 * The emitted worker's half, RUN — not grepped. `STRATEGY_SOURCE` is what ships in `sw.js`; the
 * functions above are the in-process twins an app calls and the rest of this file tests. A name
 * match proved nothing: the twins had drifted (the TS half awaited `cache.put`, so a quota failure
 * or a slow body held the answer; the emitted SWR answered `Response.error()` where every other
 * strategy rejects). Each source is evaluated with `new Function` over the same fake the TS twin
 * gets, and the two must answer alike in every scenario, the failure ones included.
 */
describe('emitted parity', () => {
  // The emitted worker's `later` (`pages-cache-source.ts`), restated: it is spliced into a template
  // there, not exported on its own, and its whole contract is this one line.
  const LATER =
    'function later(wait,p){const settled=p.catch(()=>{});if(wait)wait(settled);return settled}';

  type Emitted = (
    req: Request,
    cn: string,
    fb: (() => Promise<Response>) | undefined,
    wait: (p: Promise<unknown>) => void,
    pre: Promise<Response | undefined> | undefined,
  ) => Promise<Response>;

  function emitted(name: StrategyName, cache: StrategyCache, network: () => Promise<Response>) {
    const make = new Function(
      'openCache',
      'fetch',
      `${LATER}\n${NETWORK_SOURCE}\n${STRATEGY_SOURCE[name]}\nreturn ${STRATEGY_FN_NAMES[name]};`,
    ) as (open: () => Promise<StrategyCache>, fetch: () => Promise<Response>) => Emitted;
    return make(async () => cache, network);
  }

  interface Scenario {
    readonly label: string;
    readonly cached?: string;
    readonly network: 'ok' | 'not-found' | 'down';
    readonly preload?: boolean;
    readonly fallback?: boolean;
    readonly put?: 'ok' | 'rejects' | 'never-settles';
  }

  type Answer = { status: number; body: string } | 'rejected' | 'held';

  interface Observed {
    readonly answer: Answer;
    readonly stored: string | null;
    readonly fetched: number;
  }

  const URL_ = 'https://x.test/parity';
  const tick = (ms: number): Promise<'held'> =>
    new Promise((resolve) => setTimeout(() => resolve('held'), ms));

  function world(scenario: Scenario) {
    const store = new Map<string, Response>();
    if (scenario.cached !== undefined) store.set(URL_, new Response(scenario.cached));
    let fetched = 0;
    const waits: Promise<unknown>[] = [];
    const cache: StrategyCache = {
      match: async (request) => store.get(request.url)?.clone(),
      put: (request, response) => {
        if (scenario.put === 'rejects') return Promise.reject(new TypeError('QuotaExceededError'));
        if (scenario.put === 'never-settles') return new Promise<void>(() => undefined);
        store.set(request.url, response);
        return Promise.resolve();
      },
    };
    const network = (): Promise<Response> => {
      fetched += 1;
      if (scenario.network === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        scenario.network === 'ok' ? new Response('fresh') : new Response('nope', { status: 404 }),
      );
    };
    const fallback =
      scenario.fallback === true ? async () => new Response('offline page') : undefined;
    const preload =
      scenario.preload === true ? Promise.resolve(new Response('preloaded')) : undefined;
    const observe = async (run: Promise<Response>): Promise<Observed> => {
      const answer = await Promise.race<Answer>([
        run.then(
          async (r) => ({ status: r.status, body: await r.text() }),
          () => 'rejected' as const,
        ),
        tick(50),
      ]);
      await Promise.race([Promise.all(waits), tick(20)]);
      const kept = store.get(URL_);
      return { answer, stored: kept === undefined ? null : await kept.clone().text(), fetched };
    };
    return { cache, network, fallback, preload, waits, observe };
  }

  async function viaTs(name: StrategyName, scenario: Scenario): Promise<Observed> {
    const w = world(scenario);
    const env: StrategyEnv = {
      open: async () => w.cache,
      fetch: w.network,
      wait: (p) => w.waits.push(p),
    };
    return w.observe(
      STRATEGY_FNS[name](new Request(URL_), env, {
        cacheName: 'test',
        ...(w.fallback === undefined ? {} : { fallback: w.fallback }),
        ...(w.preload === undefined ? {} : { preload: w.preload }),
      }),
    );
  }

  async function viaEmitted(name: StrategyName, scenario: Scenario): Promise<Observed> {
    const w = world(scenario);
    const fn = emitted(name, w.cache, w.network);
    return w.observe(fn(new Request(URL_), 'test', w.fallback, (p) => w.waits.push(p), w.preload));
  }

  const SCENARIOS: readonly Scenario[] = [
    { label: 'cached, network up', cached: 'stale', network: 'ok' },
    { label: 'nothing cached, network up', network: 'ok' },
    { label: 'nothing cached, network answers 404', network: 'not-found' },
    { label: 'cached, network down', cached: 'stale', network: 'down' },
    { label: 'nothing cached, network down, a fallback', network: 'down', fallback: true },
    { label: 'nothing cached, network down, no fallback', network: 'down' },
    { label: 'a navigation preload answers first', network: 'ok', preload: true },
    { label: 'the cache copy rejects (quota)', cached: 'stale', network: 'ok', put: 'rejects' },
    { label: 'the cache copy rejects, nothing cached', network: 'ok', put: 'rejects' },
    { label: 'the cache copy never settles', network: 'ok', put: 'never-settles' },
  ];

  for (const name of STRATEGY_NAMES) {
    test.each(SCENARIOS.map((s) => [s.label, s] as const))(
      `each emitted strategy answers what its TS twin answers: ${name}, %s`,
      async (_label, scenario) => {
        const ts = await viaTs(name, scenario);
        const shipped = await viaEmitted(name, scenario);
        expect(ts).toEqual(shipped);
        // Neither half may hold the answer behind the copy, or lose the answer to it.
        expect(ts.answer).not.toBe('held');
      },
    );
  }
});
