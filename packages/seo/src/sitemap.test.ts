import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord } from './routes';
import {
  buildSitemap,
  chunk,
  SITEMAP_INDEX_MAX_FILES,
  SITEMAP_MAX_URLS,
  sitemapUrls,
} from './sitemap';

const BASE = { baseUrl: 'https://ultimate.dev' } as const;

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'path' | 'file'>): RouteRecord {
  return { surface: 'site', render: 'static', ...partial };
}

describe('sitemapUrls', () => {
  test('expands a dynamic route through its prerender enumeration', async () => {
    const urls = await sitemapUrls(
      [
        route({ path: '/', file: 'site/page.tsx' }),
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          prerender: () => ['/blog/a', '/blog/b'],
        }),
      ],
      BASE,
    );
    expect(urls.map((url) => url.loc)).toEqual([
      'https://ultimate.dev',
      'https://ultimate.dev/blog/a',
      'https://ultimate.dev/blog/b',
    ]);
  });

  test('app routes and noindex routes never reach the sitemap', async () => {
    const urls = await sitemapUrls(
      [
        route({ path: '/dashboard', file: 'app/dashboard/page.tsx', surface: 'app' }),
        route({ path: '/draft', file: 'site/draft/page.tsx', noindex: true }),
        route({
          path: '/hidden',
          file: 'site/hidden/page.tsx',
          meta: { robots: { index: false } },
        }),
      ],
      BASE,
    );
    expect(urls).toEqual([]);
  });

  test('emits one URL per locale with alternates and x-default', async () => {
    const urls = await sitemapUrls([route({ path: '/pricing', file: 'site/pricing/page.tsx' })], {
      ...BASE,
      locales: ['en', 'es'],
      defaultLocale: 'en',
    });
    expect(urls.map((url) => url.loc)).toEqual([
      'https://ultimate.dev/pricing',
      'https://ultimate.dev/es/pricing',
    ]);
    expect(urls[0]?.alternates?.map((alternate) => alternate.hreflang)).toEqual([
      'en',
      'es',
      'x-default',
    ]);
    // And it points at the URL the sitemap actually lists for that locale, not merely at a path.
    const xDefault = urls[0]?.alternates?.find((alternate) => alternate.hreflang === 'x-default');
    expect(xDefault?.href).toBe('https://ultimate.dev/pricing');
    expect(urls.map((url) => url.loc)).toContain(xDefault?.href ?? '');
  });

  test('no defaultLocale means no x-default — every URL is prefixed and none is the fallback', async () => {
    // With `locales` and no `defaultLocale`, `localize` prefixes EVERY locale, so the unprefixed
    // path is a URL this sitemap never lists — and `x-default` pointed straight at it. An
    // hreflang cluster naming a URL outside itself is the shape a search engine drops the whole
    // cluster for, which costs the alternates that WERE right.
    const urls = await sitemapUrls([route({ path: '/pricing', file: 'site/pricing/page.tsx' })], {
      ...BASE,
      locales: ['en', 'de'],
    });
    expect(urls.map((url) => url.loc)).toEqual([
      'https://ultimate.dev/en/pricing',
      'https://ultimate.dev/de/pricing',
    ]);
    expect(urls[0]?.alternates?.map((alternate) => alternate.hreflang)).toEqual(['en', 'de']);
    for (const url of urls) {
      for (const alternate of url.alternates ?? []) {
        expect(urls.map((each) => each.loc)).toContain(alternate.href);
      }
    }
  });

  test('a defaultLocale outside `locales` names no URL either, so it emits no x-default', async () => {
    // `defaultLocale: 'fr'` with `locales: ['en','de']` unprefixes a locale the sitemap does not
    // emit — the same dangling href by a different route into it.
    const urls = await sitemapUrls([route({ path: '/pricing', file: 'site/pricing/page.tsx' })], {
      ...BASE,
      locales: ['en', 'de'],
      defaultLocale: 'fr',
    });
    expect(urls[0]?.alternates?.map((alternate) => alternate.hreflang)).toEqual(['en', 'de']);
  });
});

describe('buildSitemap', () => {
  test('a small site is a single sitemap.xml with no index', async () => {
    const result = await buildSitemap([route({ path: '/', file: 'site/page.tsx' })], BASE);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('/sitemap.xml');
    expect(result.index).toBeUndefined();
    expect(result.files[0]?.xml).toContain('<loc>https://ultimate.dev</loc>');
  });

  test('splits into numbered files plus an index past the 50k limit', async () => {
    const paths = Array.from({ length: 120 }, (_unused, index) => `/p/${index}`);
    const result = await buildSitemap(
      [route({ path: '/p/:id', file: 'site/p/[id]/page.tsx', prerender: () => paths })],
      { ...BASE, maxUrls: 50 },
    );
    expect(result.urlCount).toBe(120);
    expect(result.files.map((file) => file.path)).toEqual([
      '/sitemap-1.xml',
      '/sitemap-2.xml',
      '/sitemap-3.xml',
    ]);
    expect(result.files.map((file) => file.urlCount)).toEqual([50, 50, 20]);
    expect(result.index?.path).toBe('/sitemap.xml');
    expect(result.index?.xml).toContain('<sitemapindex');
    expect(result.index?.xml).toContain('https://ultimate.dev/sitemap-3.xml');
  });

  test('a maxUrls that is not a positive count is refused, never a loop that never ends', async () => {
    // `chunk` advances by `size`, so `size <= 0` never moves the cursor: one config typo turned a
    // build into an infinite loop allocating empty slices until the box ran out of memory.
    const routes = [route({ path: '/', file: 'site/page.tsx' })];
    for (const maxUrls of [0, -1, 2.5, Number.NaN]) {
      expect(await codeOf(() => buildSitemap(routes, { ...BASE, maxUrls }))).toBe('X_INVARIANT');
    }
    expect(codeOfSync(() => chunk([1, 2, 3], 0))).toBe('X_INVARIANT');
  });

  test('the protocol limit is the documented 50,000', () => {
    expect(SITEMAP_MAX_URLS).toBe(50_000);
  });

  test('escapes query strings so the XML stays well formed', async () => {
    const result = await buildSitemap(
      [route({ path: '/s/:q', file: 'site/s/[q]/page.tsx', prerender: () => ['/s?a=1&b=2'] })],
      BASE,
    );
    expect(result.files[0]?.xml).toContain('a=1&amp;b=2');
  });
});

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

function codeOfSync(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

describe('the sitemap index cap', () => {
  const manyPaths = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `/p/${index}`);

  test('more shards than a sitemap index can hold is refused, not silently truncated', async () => {
    const routes = [
      route({
        path: '/p/:id',
        file: 'site/p/[id]/page.tsx',
        prerender: () => manyPaths(SITEMAP_INDEX_MAX_FILES + 1),
      }),
    ];
    let thrown: { code?: unknown; cause?: unknown; fix?: unknown } | undefined;
    try {
      await buildSitemap(routes, { ...BASE, maxUrls: 1 });
    } catch (error) {
      thrown = error as { code?: unknown; cause?: unknown; fix?: unknown };
    }
    expect(thrown?.code).toBe(SEO_ERROR_CODES.sitemapTooLarge);
    expect(thrown?.cause).toContain(String(SITEMAP_INDEX_MAX_FILES + 1));
    expect(thrown?.cause).toContain(String(SITEMAP_INDEX_MAX_FILES));
    expect(thrown?.fix).toContain('noindex');
  });

  test('exactly the limit is allowed — the refusal is > and not >=', async () => {
    const routes = [
      route({
        path: '/p/:id',
        file: 'site/p/[id]/page.tsx',
        prerender: () => manyPaths(SITEMAP_INDEX_MAX_FILES),
      }),
    ];
    const result = await buildSitemap(routes, { ...BASE, maxUrls: 1 });
    expect(result.files).toHaveLength(SITEMAP_INDEX_MAX_FILES);
    expect(result.index?.path).toBe('/sitemap.xml');
  });
});
