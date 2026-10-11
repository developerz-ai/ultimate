// What ONE page may say about itself in a sitemap: when it last changed, and which locales it is
// listed in — beside the plain path a `prerender()` has always answered. Plus the URLs a sitemap
// must not carry at all: the ones `robots.txt` keeps crawlers out of.

import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord, SitemapPage } from './routes';
import { expandRoute, expandRoutePages } from './routes';
import { buildSitemap, sitemapUrls } from './sitemap';
import { sitemapDatetime } from './sitemap-datetime';

const ORIGIN = 'https://notificado.co';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const BASE = { baseUrl: ORIGIN, now: NOW } as const;
const LOCALES = { locales: ['es-co', 'en'], defaultLocale: 'es-co' } as const;

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'path' | 'file'>): RouteRecord {
  return { surface: 'site', render: 'static', ...partial };
}

const blog = (pages: readonly (string | SitemapPage)[]): RouteRecord =>
  route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => pages });

async function refusal(
  run: () => Promise<unknown>,
): Promise<{ code?: string; cause?: string; fix?: string }> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
  return {};
}

describe('expandRoutePages', () => {
  test('a plain path and a page object are one list; expandRoute still answers paths', async () => {
    const record = blog(['/blog/a', { path: '/blog/b', lastmod: '2026-10-01' }]);
    expect(await expandRoutePages(record)).toEqual([
      { path: '/blog/a' },
      { path: '/blog/b', lastmod: '2026-10-01' },
    ]);
    expect(await expandRoute(record)).toEqual(['/blog/a', '/blog/b']);
  });

  test('a static route is its own one page; a dynamic one with no prerender is none', async () => {
    expect(
      await expandRoutePages(route({ path: '/precios', file: 'site/precios/page.tsx' })),
    ).toEqual([{ path: '/precios' }]);
    expect(await expandRoutePages(route({ path: '/b/:id', file: 'site/b/[id]/page.tsx' }))).toEqual(
      [],
    );
  });
});

describe('a route with no params', () => {
  // The blog's index is one page whose date is its newest post's: a route with no params may
  // answer `prerender()` too, and what it says of its one page is read like any other entry.
  test('says its page`s lastmod and locales through prerender(), when it declares one', async () => {
    const urls = await sitemapUrls(
      [
        route({
          path: '/blog',
          file: 'site/blog/page.tsx',
          prerender: () => [{ path: '/blog', lastmod: '2026-10-01T00:00:00Z', locales: ['es-co'] }],
        }),
        route({ path: '/borradores', file: 'site/borradores/page.tsx', prerender: () => [] }),
      ],
      { ...BASE, ...LOCALES },
    );
    expect(urls).toEqual([{ loc: `${ORIGIN}/blog`, lastmod: '2026-10-01T00:00:00.000Z' }]);
  });
});

describe('lastmod per page', () => {
  test('a Date, a zoned ISO string and a date are each written as W3C Datetime in UTC', async () => {
    const urls = await sitemapUrls(
      [
        blog([
          { path: '/blog/a', lastmod: new Date('2026-10-01T15:04:05.000Z') },
          { path: '/blog/b', lastmod: '2026-10-05T08:30:00-05:00' },
          { path: '/blog/c', lastmod: '2026-09-30' },
          '/blog/d',
        ]),
      ],
      BASE,
    );
    expect(urls.map((url) => url.lastmod)).toEqual([
      '2026-10-01T15:04:05.000Z',
      '2026-10-05T13:30:00.000Z',
      '2026-09-30T00:00:00.000Z',
      undefined,
    ]);
  });

  test('the page`s own lastmod wins over the route`s, which wins over the build`s', async () => {
    const urls = await sitemapUrls(
      [
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          lastmod: '2026-01-01T00:00:00.000Z',
          prerender: () => [{ path: '/blog/a', lastmod: '2026-10-01T00:00:00Z' }, '/blog/b'],
        }),
        route({ path: '/precios', file: 'site/precios/page.tsx' }),
      ],
      { ...BASE, lastmod: '2025-05-05T00:00:00.000Z' },
    );
    expect(urls.map((url) => url.lastmod)).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2025-05-05T00:00:00.000Z',
    ]);
  });

  test('every locale copy of a page carries the page`s lastmod', async () => {
    const result = await buildSitemap(
      [blog([{ path: '/blog/a', lastmod: '2026-10-01T00:00:00Z' }])],
      {
        ...BASE,
        ...LOCALES,
      },
    );
    expect(
      result.files[0]?.xml.match(/<lastmod>2026-10-01T00:00:00\.000Z<\/lastmod>/g),
    ).toHaveLength(2);
  });

  // CLAMPED, not refused: one row stamped by a database a second ahead of this process would
  // otherwise fail the whole enumeration — and "no later than now" is the true bound on a past event.
  test('a lastmod in the future is clamped to now', async () => {
    const urls = await sitemapUrls(
      [blog([{ path: '/blog/a', lastmod: '2031-01-01T00:00:00Z' }])],
      BASE,
    );
    expect(urls[0]?.lastmod).toBe('2026-10-11T12:00:00.000Z');
  });

  test('a lastmod that is no date is refused, naming the route file and the page', async () => {
    for (const lastmod of ['yesterday', '', '2026-13-45', new Date(Number.NaN)]) {
      const error = await refusal(() => sitemapUrls([blog([{ path: '/blog/a', lastmod }])], BASE));
      expect(error.code).toBe(SEO_ERROR_CODES.sitemapEntryInvalid);
      expect(error.cause).toContain('site/blog/[slug]/page.tsx');
      expect(error.cause).toContain('/blog/a');
      expect(error.fix).toContain('site/blog/[slug]/page.tsx');
    }
  });

  // `Date.parse` reads a zoneless time in the PROCESS's zone: the same row would be a different
  // instant on a laptop in Bogotá and in a container on UTC.
  test('a time with no zone is refused rather than read in the ambient one', async () => {
    for (const lastmod of ['2026-10-01T10:00:00', 'October 1, 2026', '10/01/2026']) {
      const error = await refusal(() => sitemapUrls([blog([{ path: '/blog/a', lastmod }])], BASE));
      expect(error.code).toBe(SEO_ERROR_CODES.sitemapEntryInvalid);
      expect(error.cause).toContain('zone');
    }
  });

  test('sitemapDatetime is the one normaliser', () => {
    expect(sitemapDatetime('2026-10-01T00:00:00+02:00', NOW)).toBe('2026-09-30T22:00:00.000Z');
    expect(sitemapDatetime('2026-10-01T00:00Z', NOW)).toBe('2026-10-01T00:00:00.000Z');
    expect(sitemapDatetime('nope', NOW)).toBeUndefined();
  });
});

describe('locales per page', () => {
  test('a page listed in one locale is one <url>, with no alternates pointing at the other', async () => {
    const result = await buildSitemap(
      [blog([{ path: '/blog/solo', locales: ['es-co'] }, '/blog/ambos'])],
      { ...BASE, ...LOCALES },
    );
    const xml = result.files[0]?.xml ?? '';
    expect(xml).toContain(`<loc>${ORIGIN}/blog/solo</loc>`);
    expect(xml).not.toContain('/en/blog/solo');
    const solo = xml.slice(xml.indexOf('/blog/solo</loc>'), xml.indexOf('</url>'));
    expect(solo).not.toContain('xhtml:link');
    // The page in both locales is untouched: two <url>s, the full cluster on each.
    expect(xml).toContain(`<loc>${ORIGIN}/en/blog/ambos</loc>`);
    expect(xml.split(`hreflang="x-default" href="${ORIGIN}/blog/ambos"`).length - 1).toBe(2);
    expect(result.urlCount).toBe(3);
  });

  test('a cluster that leaves the default locale out names no x-default', async () => {
    const urls = await sitemapUrls([blog([{ path: '/blog/a', locales: ['en', 'pt'] }])], {
      ...BASE,
      locales: ['es-co', 'en', 'pt'],
      defaultLocale: 'es-co',
    });
    expect(urls.map((url) => url.loc)).toEqual([`${ORIGIN}/en/blog/a`, `${ORIGIN}/pt/blog/a`]);
    expect(urls[0]?.alternates?.map((alternate) => alternate.hreflang)).toEqual(['en', 'pt']);
  });

  test('the cluster keeps the app`s locale order, whatever order the page wrote', async () => {
    const urls = await sitemapUrls([blog([{ path: '/blog/a', locales: ['en', 'es-co'] }])], {
      ...BASE,
      ...LOCALES,
    });
    expect(urls.map((url) => url.loc)).toEqual([`${ORIGIN}/blog/a`, `${ORIGIN}/en/blog/a`]);
  });

  test('`locales: []` lists the page nowhere', async () => {
    const urls = await sitemapUrls([blog([{ path: '/blog/borrador', locales: [] }, '/blog/a'])], {
      ...BASE,
      ...LOCALES,
    });
    expect(urls.map((url) => url.loc)).toEqual([`${ORIGIN}/blog/a`, `${ORIGIN}/en/blog/a`]);
    // And on a single-locale site, where there is no cluster to trim: still nowhere.
    const single = await sitemapUrls(
      [blog([{ path: '/blog/borrador', locales: [] }, '/blog/a'])],
      BASE,
    );
    expect(single.map((url) => url.loc)).toEqual([`${ORIGIN}/blog/a`]);
  });

  test('a locale the app does not route is refused, naming the file — never a silent drop', async () => {
    const error = await refusal(() =>
      sitemapUrls([blog([{ path: '/blog/a', locales: ['es-co', 'en-us'] }])], {
        ...BASE,
        ...LOCALES,
      }),
    );
    expect(error.code).toBe(SEO_ERROR_CODES.sitemapEntryInvalid);
    expect(error.cause).toContain('"en-us"');
    expect(error.cause).toContain('site/blog/[slug]/page.tsx');
    expect(error.cause).toContain('es-co, en');
  });

  test('a route`s own `locales` is the default for its pages; a page`s wins', async () => {
    const urls = await sitemapUrls(
      [
        route({ path: '/legal', file: 'site/legal/page.tsx', locales: ['es-co'] }),
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          locales: ['es-co'],
          prerender: () => ['/blog/a', { path: '/blog/b', locales: ['es-co', 'en'] }],
        }),
      ],
      { ...BASE, ...LOCALES },
    );
    expect(urls.map((url) => url.loc)).toEqual([
      `${ORIGIN}/legal`,
      `${ORIGIN}/blog/a`,
      `${ORIGIN}/blog/b`,
      `${ORIGIN}/en/blog/b`,
    ]);
    expect(urls[0]?.alternates).toBeUndefined();
  });
});

describe('disallow', () => {
  test('a URL robots.txt keeps crawlers out of is not listed, in any locale', async () => {
    const urls = await sitemapUrls(
      [
        route({ path: '/panel', file: 'site/panel/page.tsx' }),
        route({ path: '/panel-de-control', file: 'site/panel-de-control/page.tsx' }),
        route({ path: '/precios', file: 'site/precios/page.tsx' }),
      ],
      { ...BASE, disallow: ['/panel/', '/panel$', '/*/panel$'], ...LOCALES },
    );
    expect(urls.map((url) => url.loc)).toEqual([
      `${ORIGIN}/panel-de-control`,
      `${ORIGIN}/en/panel-de-control`,
      `${ORIGIN}/precios`,
      `${ORIGIN}/en/precios`,
    ]);
  });

  test('a rule that keeps one locale copy out trims the cluster to what is left', async () => {
    const urls = await sitemapUrls([route({ path: '/precios', file: 'site/precios/page.tsx' })], {
      ...BASE,
      ...LOCALES,
      disallow: ['/en/'],
    });
    expect(urls.map((url) => url.loc)).toEqual([`${ORIGIN}/precios`]);
    expect(urls[0]?.alternates).toBeUndefined();
  });

  test('a plain rule is a prefix, as a crawler reads it', async () => {
    const urls = await sitemapUrls(
      [
        route({ path: '/api', file: 'site/api/page.tsx' }),
        route({ path: '/apis-abiertas', file: 'site/apis-abiertas/page.tsx' }),
        route({ path: '/', file: 'site/page.tsx' }),
      ],
      { ...BASE, disallow: ['/api'] },
    );
    expect(urls.map((url) => url.loc)).toEqual([ORIGIN]);
  });
});
