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
 * admin, KYC and payment islands too (~1 MB on notificado.co). A chunk the precache does not name
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
