// `seo.sitemap.sections` / `pageSize` and a page's own `lastmod` / `locales`, through `siteSeo` —
// the one answer the web role serves and the static export writes — and `writeSiteSeo`, which is
// how the export puts every file of it on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture's files are root-relative.
import { join } from 'node:path';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { SEO_ERROR_CODES } from '@ultimat3/seo';
import { processRoot } from './process-root-fixture';
import { type SiteSeoOptions, siteSeo } from './site-seo';
import { writeSiteSeo } from './site-seo-write';
import { resetLastmodCache } from './sitemap-lastmod';

const route = (file: string, patch: Partial<RouteConfig> = {}): void => {
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

const BASE = 'https://notificado.co';
const ROOT = processRoot(join(import.meta.dir, '..', '.site-seo-sections-fixture'));
const SECTIONS = [
  { name: 'blog', match: '/blog/**' },
  { name: 'ciudades', match: '/juzgados/**' },
];

const declareLocales = async (): Promise<void> => {
  await Bun.write(
    join(ROOT, 'packages/i18n/src/index.ts'),
    "import { defineCatalogs } from '@ultimat3/i18n';\n" +
      "export const catalogs = defineCatalogs({ default: 'es-co', locales: { 'es-co': {}, en: {} } });\n",
  );
  configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
};

const locs = (xml: string | undefined) =>
  [...(xml ?? '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');

const seoOf = (patch: Partial<SiteSeoOptions> = {}) =>
  siteSeo({ baseUrl: BASE, environment: 'production', root: ROOT, ...patch });

const site = (): void => {
  route('apps/web/site/page.tsx');
  route('apps/web/site/precios/page.tsx');
  route('apps/web/site/blog/page.tsx');
  route('apps/web/site/blog/[slug]/page.tsx', {
    render: 'isr',
    revalidate: { ttl: '5m' },
    prerender: () => [
      { params: { slug: 'tres' }, lastmod: new Date('2025-10-03T00:00:00Z') },
      { params: { slug: 'uno' }, lastmod: '2025-10-01T09:00:00-05:00' },
      'dos',
    ],
  });
  route('apps/web/site/juzgados/[ciudad]/page.tsx', { prerender: () => ['medellin', 'bogota'] });
};

beforeEach(() => {
  resetLocaleConfig();
  clearRoutes();
  resetLastmodCache();
});

afterEach(async () => {
  clearRoutes();
  resetLocaleConfig();
  resetLastmodCache();
  await rm(ROOT, { recursive: true, force: true });
});

describe('siteSeo — sections', () => {
  test('with no sections the answer is the one urlset it always was', async () => {
    site();
    const seo = await seoOf({ sitemap: { extra: [], lastmod: 'none' } });
    expect(seo.sitemaps.map((file) => file.path)).toEqual(['/sitemap.xml']);
    expect(seo.sitemaps[0]?.xml).toContain('<urlset');
  });

  test('sections make /sitemap.xml an index of named, paginated children', async () => {
    site();
    const seo = await seoOf({
      sitemap: { extra: [], lastmod: 'none', sections: SECTIONS, pageSize: 2 },
    });
    expect(seo.sitemaps.map((file) => file.path)).toEqual([
      '/sitemap.xml',
      '/sitemaps/pages-1.xml',
      '/sitemaps/blog-1.xml',
      '/sitemaps/blog-2.xml',
      '/sitemaps/ciudades-1.xml',
    ]);
    const [index, pages, blog1, blog2, ciudades] = seo.sitemaps;
    expect(index?.xml).toContain('<sitemapindex');
    expect(locs(index?.xml)).toEqual(seo.sitemaps.slice(1).map((file) => `${BASE}${file.path}`));
    expect(locs(pages?.xml)).toEqual([BASE, `${BASE}/precios`]);
    expect(locs(blog1?.xml)).toEqual([`${BASE}/blog`, `${BASE}/blog/dos`]);
    expect(locs(blog2?.xml)).toEqual([`${BASE}/blog/tres`, `${BASE}/blog/uno`]);
    expect(locs(ciudades?.xml)).toEqual([`${BASE}/juzgados/bogota`, `${BASE}/juzgados/medellin`]);
    // The index says of each child the newest date inside it, and nothing of one with no dates.
    expect(index?.xml).toContain(
      `<loc>${BASE}/sitemaps/blog-2.xml</loc>\n    <lastmod>2025-10-03T00:00:00.000Z</lastmod>`,
    );
    expect(index?.xml.match(/<lastmod>/g)).toHaveLength(1);
    // robots.txt names the index alone: a crawler finds the children through it.
    expect(seo.robots.match(/^Sitemap: .*$/gm)).toEqual([`Sitemap: ${BASE}/sitemap.xml`]);
  });

  test('a page`s own lastmod is written; a page with none takes the route file`s', async () => {
    site();
    const xml = (await seoOf()).sitemaps[0]?.xml ?? '';
    expect(xml).toContain(
      `<loc>${BASE}/blog/uno</loc>\n    <lastmod>2025-10-01T14:00:00.000Z</lastmod>`,
    );
    expect(xml).toContain(`<loc>${BASE}/blog/dos</loc>\n  </url>`);
    const built =
      (await seoOf({ sitemap: { extra: [], lastmod: 'build' } })).sitemaps[0]?.xml ?? '';
    expect(built).toContain(`<loc>${BASE}/blog/tres</loc>\n    <lastmod>2025-10-03T00:00:00.000Z`);
    expect(built).toMatch(new RegExp(`<loc>${BASE}/blog/dos</loc>\\n    <lastmod>`));
  });

  test('a lastmod that is no date fails the enumeration, typed and naming the route file', async () => {
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => [{ params: { slug: 'a' }, lastmod: 'ayer' }],
    });
    const error = await seoOf().then(
      () => undefined,
      (thrown: unknown) => thrown as { code?: string; cause?: string },
    );
    expect(error?.code).toBe(SEO_ERROR_CODES.sitemapEntryInvalid);
    expect(error?.cause).toContain('apps/web/site/blog/[slug]/page.tsx');
  });
});

describe('siteSeo — the locales a page is listed in', () => {
  test('an entry`s `locales` lists it — and cross-links it — in those locales only', async () => {
    await declareLocales();
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => [{ params: { slug: 'solo' }, locales: ['es-co'] }, 'ambos'],
    });
    const xml = (await seoOf()).sitemaps[0]?.xml ?? '';
    expect(locs(xml)).toEqual([`${BASE}/blog/solo`, `${BASE}/blog/ambos`, `${BASE}/en/blog/ambos`]);
    expect(xml).not.toContain('/en/blog/solo');
    expect(xml).toContain(`hreflang="en" href="${BASE}/en/blog/ambos"`);
  });

  // The page asks crawlers to stay away IN ENGLISH: its Spanish copy is listed, alone, and no
  // hreflang points a crawler at the copy that says noindex.
  test('a page whose meta is noindex in one locale is listed in the others only', async () => {
    await declareLocales();
    route('apps/web/site/precios/page.tsx');
    route('apps/web/site/terminos/page.tsx', {
      meta: async (ctx) => ({
        title: 'Términos',
        description: 'los términos',
        ...(ctx.locale === 'en' ? { robots: { index: false } } : {}),
      }),
    });
    route('apps/web/site/gracias/page.tsx', {
      meta: async () => ({ title: 'Gracias', description: 'gracias', robots: { index: false } }),
    });
    const xml = (await seoOf()).sitemaps[0]?.xml ?? '';
    expect(locs(xml)).toEqual([`${BASE}/precios`, `${BASE}/en/precios`, `${BASE}/terminos`]);
    const terminos = xml.slice(xml.indexOf('/terminos</loc>'));
    expect(terminos).not.toContain('xhtml:link');
  });

  test('the static export`s pages carry what prerender() says of each; the LIST stays the report`s', async () => {
    await declareLocales();
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => [
        { params: { slug: 'uno' }, lastmod: '2025-10-01T00:00:00Z', locales: ['es-co'] },
        { params: { slug: 'no-emitida' }, lastmod: '2025-10-02T00:00:00Z' },
      ],
    });
    const seo = await seoOf({ pagesFor: () => ['/blog/uno', '/en/blog/uno', '/blog/otra'] });
    const xml = seo.sitemaps[0]?.xml ?? '';
    expect(locs(xml)).toEqual([`${BASE}/blog/uno`, `${BASE}/blog/otra`, `${BASE}/en/blog/otra`]);
    expect(xml).toContain(`<loc>${BASE}/blog/uno</loc>\n    <lastmod>2025-10-01T00:00:00.000Z`);
  });
});

describe('siteSeo — a route with no params and a `load`', () => {
  // Its `meta` needs a request, so the sitemap cannot read it; its `prerender()` entry can still
  // say when the page changed and where it is listed.
  const index = (patch: Partial<RouteConfig>): void =>
    route('apps/web/site/blog/page.tsx', {
      render: 'isr',
      revalidate: { ttl: '5m' },
      load: () => Promise.resolve({ posts: 3 }),
      ...patch,
    } as Partial<RouteConfig>);

  test('its prerender() entry carries the page`s lastmod and locales', async () => {
    await declareLocales();
    index({
      prerender: () => [{ params: {}, lastmod: '2025-10-04T00:00:00Z', locales: ['es-co'] }],
    });
    const xml = (await seoOf()).sitemaps[0]?.xml ?? '';
    expect(locs(xml)).toEqual([`${BASE}/blog`]);
    expect(xml).toContain('<lastmod>2025-10-04T00:00:00.000Z</lastmod>');
  });

  test('a static export lists it whether or not the build emitted it: only a DYNAMIC route`s list is the report`s', async () => {
    index({ prerender: () => [{ params: {}, lastmod: '2025-10-04T00:00:00Z' }] });
    const seo = await seoOf({ pagesFor: () => [] });
    expect(locs(seo.sitemaps[0]?.xml)).toEqual([`${BASE}/blog`]);
  });
});

describe('siteSeo — robots and the sitemap agree', () => {
  test('a URL seo.robots.disallow keeps crawlers out of is not listed', async () => {
    route('apps/web/site/precios/page.tsx');
    route('apps/web/site/interno/page.tsx');
    route('apps/web/site/interno/[id]/page.tsx', { prerender: () => ['a'] });
    const seo = await seoOf({ disallow: ['/interno'] });
    expect(locs(seo.sitemaps[0]?.xml)).toEqual([`${BASE}/precios`]);
    expect(seo.robots).toContain('Disallow: /interno');
  });
});

describe('writeSiteSeo — the static export', () => {
  test('writes the index, every child it names and robots.txt — the bytes the web role serves', async () => {
    site();
    const seo = await seoOf({
      sitemap: { extra: [], lastmod: 'none', sections: SECTIONS, pageSize: 2 },
    });
    const out = join(ROOT, 'out');
    const written = await writeSiteSeo(out, seo);
    expect(written).toEqual([
      '/sitemap.xml',
      '/sitemaps/pages-1.xml',
      '/sitemaps/blog-1.xml',
      '/sitemaps/blog-2.xml',
      '/sitemaps/ciudades-1.xml',
      '/robots.txt',
    ]);
    for (const file of seo.sitemaps) {
      expect(await Bun.file(join(out, file.path)).text()).toBe(file.xml);
    }
    expect(await Bun.file(join(out, 'robots.txt')).text()).toBe(seo.robots);
    // Every child the index names is a file on disk.
    for (const loc of locs(await Bun.file(join(out, 'sitemap.xml')).text())) {
      expect(await Bun.file(join(out, new URL(loc).pathname)).exists()).toBe(true);
    }
  });
});
