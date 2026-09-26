// What the worker is told: every route once per routed locale, personal pages never cached, and a
// precache that carries only the islands a precached page boots.

import { describe, expect, test } from 'bun:test';
import { routeDescriptor } from '../e2e/route-descriptor-fixture';
import type { IslandChunk } from './island-bundle';
import { islandBundle } from './island-bundle';
import type { PwaArtifacts } from './pwa-artifacts';
import { styleBundleOf } from './style-bundle';
import type { RenderedDocument, ServiceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerArtifacts } from './sw-artifacts';

const pwa: PwaArtifacts = {
  body: '{}',
  head: '',
  headFor: () => '',
  manifests: [],
  offline: {
    fallback: '/offline',
    image: null,
    font: null,
    neverCache: [],
    personalPages: 'never',
  },
  backgroundSync: false,
  push: false,
};

const chunk = (file: string, url: string): IslandChunk => ({
  file,
  moduleId: url.slice('/islands/'.length, -'.js'.length),
  url,
  code: '',
  bytes: 1000,
});

const HERO = chunk('apps/web/site/hero.island.tsx', '/islands/hero-1.js');
const OFFLINE_RETRY = chunk('apps/web/site/offline/retry.island.tsx', '/islands/retry-2.js');
const KYC = chunk('apps/web/app/kyc/kyc-form.island.tsx', '/islands/kyc-form-3.js');
const WIZARD = chunk('apps/web/app/casos/wizard.island.tsx', '/islands/wizard-4.js');
const NAMED = chunk('apps/web/site/precios/plan.island.tsx', '/islands/plan-5.js');

const ROUTES = [
  {
    ...routeDescriptor({ path: '/', surface: 'site', mode: 'static', offline: 'precache' }),
    file: 'apps/web/site/page.tsx',
    islandSources: ['./hero.island.tsx'],
  },
  {
    ...routeDescriptor({ path: '/offline', surface: 'site', mode: 'static', offline: 'runtime' }),
    islandSources: ['./retry.island.tsx'],
  },
  routeDescriptor({ path: '/precios', surface: 'site', mode: 'static', offline: 'precache' }),
  {
    ...routeDescriptor({
      path: '/kyc',
      surface: 'app',
      mode: 'ssr',
      offline: 'precache',
      personal: true,
    }),
    islandSources: ['./kyc-form.island.tsx'],
  },
  {
    ...routeDescriptor({ path: '/casos', surface: 'app', mode: 'ssr', offline: 'runtime' }),
    islandSources: ['./wizard.island.tsx'],
  },
];

const LOCALES = { routed: ['es-co', 'en'], fallback: 'es-co' };

const build = (
  documents: ReadonlyMap<string, RenderedDocument> = new Map(),
): ServiceWorkerArtifacts => {
  const built = serviceWorkerArtifacts({
    pwa,
    buildId: 'build-1',
    routes: ROUTES,
    islands: islandBundle([HERO, OFFLINE_RETRY, KYC, WIZARD, NAMED]),
    styles: styleBundleOf([]),
    documents,
    locales: LOCALES,
  });
  if (built === undefined) expect.unreachable('an app with a fallback got no service worker');
  return built;
};

const precachedUrls = (built: ServiceWorkerArtifacts): readonly string[] =>
  built.precache.entries.map((entry) => entry.url);

describe('the precache carries only the islands a precached page boots', () => {
  test('a precached page’s declared island is in; a runtime or personal page’s is not', () => {
    const urls = precachedUrls(build());
    expect(urls).toContain(HERO.url);
    // The offline document boots its island offline, whatever its own route declares.
    expect(urls).toContain(OFFLINE_RETRY.url);
    expect(urls).not.toContain(KYC.url);
    expect(urls).not.toContain(WIZARD.url);
    expect(urls).not.toContain(NAMED.url);
  });

  test('a chunk a precached document names is in, though no route declared it', () => {
    const documents = new Map([
      ['/precios', { revision: 'r1', bytes: 10, assets: [NAMED.url, '/elsewhere.js'] }],
    ]);
    const urls = precachedUrls(build(documents));
    expect(urls).toContain(NAMED.url);
    expect(urls).not.toContain('/elsewhere.js');
  });

  test('every other chunk is cached on first use, by the islands prefix rule', () => {
    const built = build();
    expect(built.source).toContain('{"p":"^/islands/","s":"cacheFirst","c":"runtime","a":1}');
  });
});

describe('a personal page', () => {
  test('is network-only in every locale, and never precached', () => {
    const built = build();
    expect(built.source).toContain('{"p":"^/kyc/?$","s":"networkOnly","c":"runtime"}');
    expect(built.source).toContain('{"p":"^/en/kyc/?$","s":"networkOnly","c":"runtime"}');
    expect(precachedUrls(built)).not.toContain('/kyc');
    expect(precachedUrls(built)).not.toContain('/en/kyc');
  });
});

describe('every route, once per routed locale', () => {
  test('the English spelling has its own rule, in the same cache as the default one', () => {
    const source = build().source;
    expect(source).toContain('{"p":"^/en/precios/?$","s":"networkFirst","c":"precache"}');
    expect(source).toContain('{"p":"^/en/casos/?$","s":"networkFirst","c":"pages"}');
    expect(source).toContain('{"p":"^/en/?$","s":"networkFirst","c":"precache"}');
  });

  test('the English document is precached at its own content hash', () => {
    const documents = new Map([
      ['/precios', { revision: 'es-hash', bytes: 10 }],
      ['/en/precios', { revision: 'en-hash', bytes: 12 }],
    ]);
    const entries = build(documents).precache.entries;
    expect(entries.find((entry) => entry.url === '/en/precios')?.revision).toBe('en-hash');
    expect(entries.find((entry) => entry.url === '/precios')?.revision).toBe('es-hash');
  });

  test('the worker knows the prefix, so an English navigation offline gets /en/offline', () => {
    expect(build().source).toContain('const OFFLINE_LOCALES=["en"];');
  });

  test('a single-locale app gets exactly one spelling per route', () => {
    const built = serviceWorkerArtifacts({
      pwa,
      buildId: 'build-1',
      routes: ROUTES,
      islands: islandBundle([]),
      styles: styleBundleOf([]),
      locales: { routed: ['en'], fallback: 'en' },
    });
    expect(built?.source).not.toContain('^/en/');
    expect(built?.source).toContain('const OFFLINE_LOCALES=[];');
  });
});
