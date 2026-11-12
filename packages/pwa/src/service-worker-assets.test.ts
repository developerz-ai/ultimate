// Runtime-cached assets and the per-locale offline document, through the emitted worker.

import { describe, expect, test } from 'bun:test';
import { generateServiceWorker } from './service-worker';
import { config, swHarness } from './service-worker-harness-fixture';
import type { PwaRoute } from './strategies';

const ROUTES: readonly PwaRoute[] = [
  { path: '/', surface: 'site', mode: 'static', offline: 'precache' },
  { path: '/offline', surface: 'site', mode: 'static', offline: 'precache' },
  { path: '/en/offline', surface: 'site', mode: 'static', offline: 'precache' },
  { path: '/casos', surface: 'app', mode: 'ssr', offline: 'runtime' },
  // The caller spells every route once per routed locale (`@ultimat3/cli`'s `sw-artifacts.ts`).
  { path: '/en/casos', surface: 'app', mode: 'ssr', offline: 'runtime' },
];

/**
 * Every island chunk was precached, so a first anonymous visit to the home page downloaded the
 * admin, KYC and payment islands too (~1 MB on one adopter). A chunk the precache does not name
 * is cached the first time a page asks for it — content-addressed, so cache-first is exact.
 */
describe('a runtime asset prefix', () => {
  const withIslands = { ...config, runtimeAssets: ['/islands/'] };

  test('is its own rule, ahead of every page, and costs nothing at install', async () => {
    const output = generateServiceWorker(ROUTES, withIslands, 'build-1');
    expect(output.rules[0]).toEqual({
      pattern: '^/islands/',
      strategy: 'cache-first',
      cache: 'runtime',
      asset: true,
    });
    const sw = swHarness();
    sw.load(output.source);
    await sw.install();
    expect(sw.fetched.filter((url) => url.includes('/islands/'))).toEqual([]);
  });

  test('a chunk is fetched once, then answered from the runtime cache — offline too', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withIslands, 'build-1').source);
    await sw.request('/islands/kyc-form-46f06d5d.js');
    expect(await (await sw.request('/islands/kyc-form-46f06d5d.js')).text()).toBe(
      'bytes for /islands/kyc-form-46f06d5d.js',
    );
    sw.goOffline();
    expect(await (await sw.request('/islands/kyc-form-46f06d5d.js')).text()).toBe(
      'bytes for /islands/kyc-form-46f06d5d.js',
    );
    expect(sw.fetched.filter((url) => url.endsWith('kyc-form-46f06d5d.js'))).toHaveLength(1);
  });

  test('is fetched as the browser asked — no build-id header on a script request', async () => {
    // A classic script is a `no-cors` request, whose headers a worker may not extend: stamping one
    // throws a TypeError, and the chunk would fail to load at all.
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withIslands, 'build-1').source);
    await sw.request('/islands/a-1.js');
    expect(sw.stamps).toEqual([null]);
  });

  test('refuses a relative prefix, which would never match a pathname', () => {
    expect(() =>
      generateServiceWorker(ROUTES, { ...config, runtimeAssets: ['islands/'] }, 'build-1'),
    ).toThrow('X_SW_SCOPE_INVALID');
  });
});

/**
 * An English navigation that finds no network got the default locale's offline document — a
 * Spanish page on `/en/…`. The worker picks the offline document spelled in the URL's locale, when
 * that one is precached.
 */
describe('the offline document per locale', () => {
  const localized = { ...config, localePrefixes: ['en'] };

  test('a prefixed navigation gets the prefixed offline document', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, localized, 'build-1').source);
    await sw.install();
    sw.goOffline();
    const en = await sw.respondNavigate('/en/casos');
    expect(await en.text()).toBe('bytes for /en/offline');
    const es = await sw.respondNavigate('/casos');
    expect(await es.text()).toBe('bytes for /offline');
  });

  test('and the default one when the prefixed document was never precached', async () => {
    const sw = swHarness();
    const routes = ROUTES.filter((route) => route.path !== '/en/offline');
    sw.load(generateServiceWorker(routes, localized, 'build-1').source);
    await sw.install();
    sw.goOffline();
    expect(await (await sw.respondNavigate('/en/casos')).text()).toBe('bytes for /offline');
  });
});

/**
 * A stylesheet sat in `x-precache-<build>` and the offline document still rendered unstyled: no
 * rule matched `/styles/<hash>.css`, so the request went to the network, and the precache was a
 * copy nothing read. A precached asset is answered from the precache: from it first when its
 * revision is its URL (content-addressed), from the network first otherwise.
 */
describe('a precached asset', () => {
  const assets = [
    { url: '/styles/site-3f2a9c1b.css', revision: '/styles/site-3f2a9c1b.css', bytes: 1 },
    { url: '/islands/feed-46f06d5d.js', revision: '/islands/feed-46f06d5d.js', bytes: 1 },
    { url: '/offline.png', revision: 'build-1', bytes: 1 },
  ];
  const withAssets = { ...config, runtimeAssets: ['/islands/'], assets };

  test('is answered from the precache offline: the offline document is styled', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withAssets, 'build-1').source);
    await sw.install();
    await sw.activate();
    sw.goOffline();
    expect(await (await sw.request('/styles/site-3f2a9c1b.css')).text()).toBe(
      'bytes for /styles/site-3f2a9c1b.css',
    );
    expect(await (await sw.request('/offline.png')).text()).toBe('bytes for /offline.png');
  });

  test('content-addressed, it is never downloaded twice — not even an island chunk', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withAssets, 'build-1').source);
    await sw.install();
    await sw.activate();
    await sw.request('/styles/site-3f2a9c1b.css');
    await sw.request('/islands/feed-46f06d5d.js');
    const fetchedOnce = (path: string) => sw.fetched.filter((url) => url.includes(path));
    expect(fetchedOnce('/styles/site-3f2a9c1b.css')).toHaveLength(1);
    expect(fetchedOnce('/islands/feed-46f06d5d.js')).toHaveLength(1);
  });

  test('not content-addressed, it goes to the network first while there is one', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withAssets, 'build-1').source);
    await sw.install();
    sw.answerWith((request) =>
      new URL(request.url).pathname === '/offline.png' ? new Response('fresh') : undefined,
    );
    expect(await (await sw.request('/offline.png')).text()).toBe('fresh');
  });

  test('a stylesheet the precache does not name is left to the browser', async () => {
    const sw = swHarness();
    sw.load(generateServiceWorker(ROUTES, withAssets, 'build-1').source);
    const factory = sw.respond('/styles/other-00000000.css');
    await expect(factory).rejects.toThrow('no handler answered');
  });
});
