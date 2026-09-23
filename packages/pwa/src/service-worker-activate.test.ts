// The emitted activate block and the streamed-response path through the worker, executed.

import { describe, expect, test } from 'bun:test';
import { generateServiceWorker } from './service-worker';
import { config, SW_ORIGIN, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute } from './strategies';

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
    await Bun.sleep(10); // the warm-up's fetch leaves after activation — let it, then go offline

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
  const streamedRoutes: readonly PwaRoute[] = [
    { path: '/feed', surface: 'app', mode: 'stream', offline: 'runtime' },
    { path: '/about', surface: 'site', mode: 'isr', offline: 'runtime' },
    { path: '/news', surface: 'site', mode: 'ssr', offline: 'runtime' },
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
    const done = await Promise.race([
      sw.activate().then(() => 'activated' as const),
      new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 500)),
    ]);
    gate.finish();
    expect(done).toBe('activated');
  });

  test.each([
    ['a private stream (stale-while-revalidate)', '/feed', { 'x-ultimate-scope': 's1' }],
    ['a shareable page (stale-while-revalidate)', '/about', {}],
    ['a shareable page (network-first)', '/news', {}],
  ] as const)(
    '%s: the page reads the first chunk before the body ends',
    async (_label, path, extra) => {
      const sw = swHarness();
      sw.load(generateServiceWorker(streamedRoutes, config, 'build-1').source);
      const gate = gatedBody();
      sw.answerWith(() => new Response(gate.body, { headers: { ...extra } }));

      const response = await Promise.race([
        sw.respond(path),
        new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 500)),
      ]);
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
