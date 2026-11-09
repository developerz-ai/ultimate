// Every public framework route that answers a type the `compress` stage codes must DECLARE its
// length: an undeclared body is coded as a stream, so a stylesheet or a sitemap missing the header
// leaves with no `content-length` at all instead of one coded whole. The route sets are the ones
// `serve.ts` and `x dev` mount, and a public GET route added to one without a URL below fails the
// coverage test, never passes quietly.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer, isCompressibleType, type Route } from '@ultimat3/http';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { SITEMAP_MAX_URLS } from '@ultimat3/seo';
import { routeDescriptor } from '../e2e/route-descriptor-fixture';
import { islandBundle } from './island-bundle';
import { type PwaArtifacts, pwaManifestRoute } from './pwa-artifacts';
import { seoRoutes } from './seo-routes';
import { styleBundle, styleBundleOf } from './style-bundle';
import { styleRoutes } from './style-routes';
import { serviceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerRoutes } from './sw-routes';

const PRODUCTION = { ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com/' };

const pwa: PwaArtifacts = {
  body: JSON.stringify({ name: 'Demo', short_name: 'Demo', start_url: '/' }),
  head: '<link rel="manifest" href="/manifest.webmanifest">',
  manifests: [],
  headFor: () => '<link rel="manifest" href="/manifest.webmanifest">',
  offline: {
    fallback: '/offline',
    image: null,
    font: null,
    neverCache: [],
    personalPages: 'never',
  },
  backgroundSync: false,
  push: false,
  locales: { routed: ['en'], fallback: 'en' },
};

const page = (file: string, patch: Partial<RouteConfig> = {}): void => {
  registerRoute({
    file,
    config: defineRoute({
      render: 'static',
      hydrate: 'never',
      offline: 'network-only',
      meta: () => ({ title: 'Page', description: 'a page' }),
      ...patch,
    } as Parameters<typeof defineRoute>[0]),
    component: () => 'page',
  });
};

const routeSet = (): readonly Route[] => {
  const worker = serviceWorkerArtifacts({
    pwa,
    buildId: 'length-under-test',
    routes: [
      routeDescriptor({ path: '/', surface: 'site', mode: 'static', offline: 'precache' }),
      routeDescriptor({ path: '/offline', surface: 'site', mode: 'static', offline: 'precache' }),
    ],
    islands: islandBundle([]),
    styles: styleBundleOf([]),
  });
  if (worker === undefined) expect.unreachable('an app with a fallback got no service worker');
  return [
    ...seoRoutes({ env: PRODUCTION }),
    pwaManifestRoute(pwa),
    ...serviceWorkerRoutes(worker),
    ...styleRoutes(() => styleBundle()),
  ];
};

/** One URL per public GET route name. A route with no entry here fails the coverage test. */
const urlFor = (name: string): string | undefined => {
  const urls: Readonly<Record<string, string>> = {
    'seo.robots': '/robots.txt',
    'seo.llms': '/llms.txt',
    'seo.sitemap': '/sitemap.xml',
    'seo.sitemapPart': '/sitemaps/1.xml',
    'assets.manifest': '/manifest.webmanifest',
    'pwa.serviceWorker': '/sw.js',
    'pwa.serviceWorkerRegister': '/x-sw-register.js',
    'assets.style': styleBundle().chunks[0]?.url ?? '',
  };
  return Object.hasOwn(urls, name) ? urls[name] : undefined;
};

beforeEach(() => {
  clearRoutes();
  clearStylesheets();
  page('apps/web/site/page.tsx');
  // Past the cap, so `/sitemap.xml` is an index and the parts route answers too.
  page('apps/web/site/p/[id]/page.tsx', {
    prerender: () =>
      Array.from({ length: SITEMAP_MAX_URLS + 1 }, (_unused, index) => String(index)),
  });
  loadStylesheet(
    '/srv/demo/apps/web/site/page.module.scss',
    `.hero{color:red}${'.x{}'.repeat(400)}`,
  );
});

afterEach(() => {
  clearRoutes();
  clearStylesheets();
});

describe('a compressible public answer declares its length', () => {
  test('every public GET route in the set has a URL here', () => {
    const uncovered = routeSet()
      .filter((route) => route.method === 'GET' && route.meta.auth === 'public')
      .map((route) => route.meta.name)
      .filter((name) => urlFor(name) === undefined);
    expect(uncovered).toEqual([]);
  });

  test('every answer of a coded type carries content-length equal to its bytes', async () => {
    const routes = routeSet();
    const server = httpServer({
      routes,
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: null, rateLimit: { scope: 'process' } }),
    });
    const undeclared: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const path = urlFor(route.meta.name);
      if (path === undefined || route.method !== 'GET') continue;
      const answer = await server.fetch(
        new Request(`http://x${path}`, { headers: { 'accept-encoding': 'identity' } }),
      );
      expect(answer.status, path).toBe(200);
      const bytes = (await answer.clone().arrayBuffer()).byteLength;
      if (!isCompressibleType(answer.headers.get('content-type'))) continue;
      checked += 1;
      if (answer.headers.get('content-length') !== String(bytes)) undeclared.push(path);
    }
    expect(undeclared).toEqual([]);
    // The sitemap pair, the manifest, both scripts and the stylesheet: a set that shrank to
    // nothing would pass the line above.
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});
