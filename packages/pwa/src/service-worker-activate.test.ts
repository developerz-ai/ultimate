// The emitted activate block and the streamed-response path through the worker, executed.

import { describe, expect, test } from 'bun:test';
import { generateServiceWorker } from './service-worker';
import { config, SW_ORIGIN, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute } from './strategies';

/** One macrotask. The harness runs on promises alone, so a turn lets every pending step run. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * `'held'` once `turns` macrotasks pass first: what the harness has not answered by then it is
 * holding, on any runner — a count of turns, never a duration.
 */
const withinTurns = async <T>(work: Promise<T>, turns = 10): Promise<T | 'held'> => {
  let outcome: { readonly value: T } | undefined;
  void work.then((value) => {
    outcome = { value };
  });
  for (let turn = 0; turn < turns && outcome === undefined; turn += 1) await settle();
  return outcome === undefined ? 'held' : outcome.value;
};

/**
 * The page that installed the worker loaded BEFORE the worker controlled it, so no strategy saw it:
 * a runtime-cached route was unavailable offline until a second online visit. Activation now runs
 * each controlled window's URL through its own route's strategy.
 */
describe('the emitted activate block, executed', () => {
  const runtimeRoutes: readonly PwaRoute[] = [
    { path: '/feed', surface: 'app', mode: 'ssr', offline: 'runtime' },
    { path: '/live', surface: 'app', mode: 'ssr', offline: 'network-only' },
  ];

  test('the installing page is cached on activate, so it is there offline on the first reload', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(runtimeRoutes, config, 'build-1').source);
    sw.openWindows(`${SW_ORIGIN}/feed`);
    await sw.activate();
    // The warm-up's fetch leaves after activation: wait for its copy to land, then go offline.
    const landed = (): boolean =>
      [...sw.caches.values()].some((cache) => cache.entries.has(`${SW_ORIGIN}/feed`));
    for (let turn = 0; turn < 50 && !landed(); turn += 1) await settle();
    expect(landed()).toBe(true);

    sw.goOffline();
    const response = await sw.request('/feed');
    expect(await response.text()).toBe('bytes for /feed');
  });

  test('a network-only route, another origin and a window with no URL are left alone', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(runtimeRoutes, config, 'build-1').source);
    sw.openWindows(`${SW_ORIGIN}/live`, 'https://elsewhere.test/feed');
    await sw.activate();
    expect(sw.fetched).toEqual([]);
  });

  test('a warm-up that fails does not fail the activation', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(runtimeRoutes, config, 'build-1').source);
    sw.openWindows(`${SW_ORIGIN}/feed`);
    sw.goOffline();
    await sw.activate();
    expect(sw.messages).toHaveLength(1);
  });
});

/**
 * A streamed document must reach the page chunk by chunk through the worker. A strategy that
 * awaited its cache copy before answering held the page's response until the WHOLE body had been
 * written to the cache — a `stream` route, and any slow body, reached the tab only once complete.
 */
describe('a streamed response through the worker', () => {
  // `/legacy` keeps the emitted stale-while-revalidate under test: no render mode maps to it since
  // 22.3.2, but a per-route `strategy` still can.
  const streamedRoutes: readonly PwaRoute[] = [
    { path: '/feed', surface: 'app', mode: 'stream', offline: 'runtime' },
    { path: '/about', surface: 'site', mode: 'isr', offline: 'runtime' },
    { path: '/news', surface: 'site', mode: 'ssr', offline: 'runtime' },
    {
      path: '/legacy',
      surface: 'site',
      mode: 'isr',
      offline: 'runtime',
      strategy: 'stale-while-revalidate',
    },
  ];

  function gatedBody(): { body: ReadableStream<Uint8Array>; finish(): void } {
    let finish: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        controller.enqueue(new TextEncoder().encode(' and the rest'));
        controller.close();
      },
    });
    return { body, finish: () => finish() };
  }

  // A fetch event waits for the worker to finish ACTIVATING. A warm-up that copied a streamed
  // page's whole body inside activate's waitUntil held the claimed tab's every request until it
  // ended — the /feed hang, as the e2e saw it.
  test('activation does not wait for a warm-up whose streamed body is still open', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(streamedRoutes, config, 'build-1').source);
    const gate = gatedBody();
    sw.answerWith(() => new Response(gate.body));
    sw.openWindows(`${SW_ORIGIN}/news`);
    const done = await withinTurns(sw.activate().then(() => 'activated' as const));
    gate.finish();
    expect(done).toBe('activated');
  });

  test.each([
    ['a private stream (network-first)', '/feed', { 'x-ultimate-scope': 's1' }],
    ['a shareable isr page (network-first)', '/about', {}],
    ['a shareable ssr page (network-first)', '/news', {}],
    ['a shareable page (stale-while-revalidate, by override)', '/legacy', {}],
  ] as const)(
    '%s: the page reads the first chunk before the body ends',
    async (_label, path, extra) => {
      const sw = swHarness();
      sw.load(generateServiceWorker(streamedRoutes, config, 'build-1').source);
      const gate = gatedBody();
      sw.answerWith(() => new Response(gate.body, { headers: { ...extra } }));

      const response = await withinTurns(sw.respond(path));
      if (response === 'held')
        return expect.unreachable(`the worker held ${path} until its body ended`);
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toBe('first chunk');
      gate.finish();
      await sw.settled();
    },
  );
});

/**
 * Stale-while-revalidate answers from cache and refreshes in the background. The refresh used to
 * call `waitUntil` only once its fetch came back — AFTER `respondWith` had settled with the hit —
 * which a browser refuses (`InvalidStateError`), so the worker could be killed mid-refresh and the
 * copy never land. The extension has to be taken while the event is still live.
 */
describe('a stale-while-revalidate refresh keeps its event alive', () => {
  test('waitUntil is called before the cached answer is returned, never after', async () => {
    const routes: readonly PwaRoute[] = [
      {
        path: '/about',
        surface: 'site',
        mode: 'isr',
        offline: 'runtime',
        strategy: 'stale-while-revalidate',
      },
    ];
    const sw = swHarness();
    sw.load(generateServiceWorker(routes, config, 'build-1').source);
    await sw.request('/about');

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sw.answerWith((request) =>
      request.url.endsWith('/about')
        ? (gate.then(() => new Response('fresh')) as unknown as Response)
        : undefined,
    );
    const hit = await sw.respond('/about');
    expect(await hit.text()).toBe('bytes for /about');
    release();
    // The refresh lands on its own schedule: until its fresh copy is in the cache — or a late
    // `waitUntil` was refused on the way, which is the failure — then every extension settled.
    const refreshed = async (): Promise<boolean> => {
      for (const cache of sw.caches.values()) {
        const entry = cache.entries.get(`${SW_ORIGIN}/about`);
        if (entry !== undefined && (await entry.clone().text()) === 'fresh') return true;
      }
      return false;
    };
    for (let turn = 0; turn < 50 && sw.lateWaitUntil.length === 0; turn += 1) {
      if (await refreshed()) break;
      await settle();
    }
    await sw.settled();
    expect(sw.lateWaitUntil).toEqual([]);
    expect(await refreshed()).toBe(true);
  });
});
