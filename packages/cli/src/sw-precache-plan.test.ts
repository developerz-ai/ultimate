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
import { precacheAssets } from './sw-precache-plan';

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
  imports: [],
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
  islands = islandBundle([HERO, OFFLINE_RETRY, KYC, WIZARD, NAMED]),
): ServiceWorkerArtifacts => {
  const built = serviceWorkerArtifacts({
    pwa,
    buildId: 'build-1',
    routes: ROUTES,
    islands,
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

  // An entry imports its shared chunks by name: precaching the entry without them is an island
  // that fails to boot offline on exactly the page that promised it would not.
  test('a precached island brings its shared chunks; a runtime island`s stay out', () => {
    const upload = { url: '/islands/chunk-aaaaaaaa.js', code: '', bytes: 500, importers: [] };
    const wizardOnly = { url: '/islands/chunk-bbbbbbbb.js', code: '', bytes: 500, importers: [] };
    const islands = islandBundle(
      [
        { ...HERO, imports: [upload.url] },
        OFFLINE_RETRY,
        KYC,
        { ...WIZARD, imports: [wizardOnly.url] },
        NAMED,
      ],
      [upload, wizardOnly],
    );
    const urls = precachedUrls(build(new Map(), islands));
    expect(urls).toContain(HERO.url);
    expect(urls).toContain(upload.url);
    expect(urls).not.toContain(wizardOnly.url);
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

/**
 * `pwa.offline.image` / `.font` are what the worker answers a failed image or font request with —
 * read from the PRECACHE only (`offlineFallbackSource`). Nothing put them there, so both branches
 * matched nothing unless the offline document happened to name the file. They ride the precache
 * now, on the offline document's own terms: no refusal for a URL this build cannot see (it cannot
 * see the site assets), the build id as the revision unless the URL is content-addressed.
 */
describe('the offline placeholders', () => {
  const plan = (placeholders: readonly string[]) =>
    precacheAssets({
      routes: ROUTES,
      documents: new Map(),
      locales: LOCALES,
      islands: islandBundle([HERO, OFFLINE_RETRY, KYC, WIZARD, NAMED]),
      styles: styleBundleOf([]),
      scripts: [],
      fallback: '/offline',
      placeholders: { urls: placeholders, buildId: 'build-1' },
    });

  test('a configured image and font appear in the precache manifest', () => {
    const assets = plan(['/icons/offline.png', '/assets/fonts/fallback.0a1b2c3d.woff2']);
    expect(assets).toContainEqual({ url: '/icons/offline.png', revision: 'build-1', bytes: 0 });
    // A content-hashed site asset IS its revision: same bytes, no re-download on the next deploy.
    expect(assets).toContainEqual({
      url: '/assets/fonts/fallback.0a1b2c3d.woff2',
      revision: '/assets/fonts/fallback.0a1b2c3d.woff2',
      bytes: 0,
    });
  });

  test('deduped: one URL configured twice, or already precached as a chunk, is one entry', () => {
    const assets = plan(['/offline.svg', '/offline.svg', HERO.url]);
    expect(assets.filter((a) => a.url === '/offline.svg')).toHaveLength(1);
    // The chunk's own entry wins — it carries real bytes and a content revision.
    expect(assets.filter((a) => a.url === HERO.url)).toEqual([
      { url: HERO.url, revision: HERO.url, bytes: HERO.bytes },
    ]);
  });

  test('none configured, nothing added', () => {
    expect(plan([]).map((a) => a.url)).toEqual([HERO.url, OFFLINE_RETRY.url]);
  });
});
