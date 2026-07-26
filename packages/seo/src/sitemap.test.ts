import { describe, expect, test } from 'bun:test';
import type { RouteRecord } from './routes';
import { buildSitemap, SITEMAP_MAX_URLS, sitemapUrls } from './sitemap';

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
