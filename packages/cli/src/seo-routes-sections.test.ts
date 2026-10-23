// A sectioned sitemap from a RUNNING web role: `/sitemap.xml` is the index, every child it names
// answers at `/sitemaps/<name>-<n>.xml` with the same content type and cache policy, and a refresh
// that fails keeps the whole previous answer — index and children together.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { seoRoutes } from './seo-routes';
import type { SiteSettings } from './site-config';

const BUILD_ID = 'seo-sections-under-test';
const ENV = { ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com/' };
const ORIGIN = 'https://www.example.com';
const HOUR_MS = 3_600_000;
const SITE: SiteSettings = {
  origin: null,
  disallow: [],
  sitemap: {
    extra: [],
    lastmod: 'none',
    pageSize: 2,
    sections: [{ name: 'blog', match: '/blog/**' }],
  },
};

let slugs: readonly string[] | 'down' = ['a', 'b', 'c'];
let clock = 0;

const page = (file: string, prerender?: () => readonly string[] | Promise<readonly string[]>) =>
  registerRoute({
    file,
    component: () => 'page',
    config: defineRoute({
      render: 'isr',
      revalidate: { ttl: '5m' },
      hydrate: 'never',
      offline: 'network-only',
      ...(prerender === undefined ? {} : { prerender }),
      meta: () => ({ title: 'Page', description: 'a page' }),
    }),
  });

beforeEach(() => {
  clearRoutes();
  slugs = ['a', 'b', 'c'];
  clock = 0;
  page('apps/web/site/precios/page.tsx');
  page('apps/web/site/blog/[slug]/page.tsx', () =>
    // A foreign failure handed to the code under test: the driver's, not this test's verdict.
    slugs === 'down' ? Promise.reject(new Error('the pool refused a connection')) : slugs,
  );
});

afterEach(() => {
  clearRoutes();
});

const server = (site: SiteSettings = SITE) =>
  httpServer({
    routes: seoRoutes({ env: ENV, site, now: () => clock }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
const get = (app: ReturnType<typeof server>, path: string) =>
  app.fetch(new Request(`http://10.0.0.7:3000${path}`));

describe('unit · the web role serves a sectioned sitemap', () => {
  test('/sitemap.xml is the index; each child it names answers its own urlset', async () => {
    const app = server();
    const index = await get(app, '/sitemap.xml');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await index.text();
    expect(body).toContain('<sitemapindex');
    expect(locs(body)).toEqual([
      `${ORIGIN}/sitemaps/pages-1.xml`,
      `${ORIGIN}/sitemaps/blog-1.xml`,
      `${ORIGIN}/sitemaps/blog-2.xml`,
    ]);

    const expected: Readonly<Record<string, string[]>> = {
      '/sitemaps/pages-1.xml': [`${ORIGIN}/precios`],
      '/sitemaps/blog-1.xml': [`${ORIGIN}/blog/a`, `${ORIGIN}/blog/b`],
      '/sitemaps/blog-2.xml': [`${ORIGIN}/blog/c`],
    };
    for (const [path, urls] of Object.entries(expected)) {
      const child = await get(app, path);
      expect(child.status).toBe(200);
      expect(child.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(child.headers.get('cache-control')).toBe(index.headers.get('cache-control'));
      const xml = await child.text();
      expect(xml).toContain('<urlset');
      expect(locs(xml)).toEqual(urls);
    }
  });

  test('a child the index does not name is a 404 that is never cached', async () => {
    const app = server();
    for (const path of ['/sitemaps/blog-3.xml', '/sitemaps/nada-1.xml', '/sitemaps/1.xml']) {
      const missing = await get(app, path);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toContain('no-store');
    }
  });

  test('robots.txt names the index and no child', async () => {
    const robots = await (await get(server(), '/robots.txt')).text();
    expect(robots.match(/^Sitemap: .*$/gm)).toEqual([`Sitemap: ${ORIGIN}/sitemap.xml`]);
  });

  test('with no sections the same site is one urlset and /sitemaps/* answers nothing', async () => {
    const app = server({
      ...SITE,
      sitemap: { extra: [], lastmod: 'none', sections: [], pageSize: 50_000 },
    });
    const body = await (await get(app, '/sitemap.xml')).text();
    expect(body).toContain('<urlset');
    expect(locs(body)).toHaveLength(4);
    expect((await get(app, '/sitemaps/blog-1.xml')).status).toBe(404);
  });
});

describe('unit · a sectioned sitemap refreshes behind the answer it would replace', () => {
  test('a failed prerender keeps the previous index AND its children, then the retry replaces both', async () => {
    const app = server();
    const before = await (await get(app, '/sitemap.xml')).text();
    expect(locs(before)).toHaveLength(3);

    slugs = 'down';
    clock += HOUR_MS + 1;
    const during = await get(app, '/sitemap.xml');
    expect(during.status).toBe(200);
    expect(await during.text()).toBe(before);
    await Bun.sleep(5);
    const child = await get(app, '/sitemaps/blog-2.xml');
    expect(child.status).toBe(200);
    expect(locs(await child.text())).toEqual([`${ORIGIN}/blog/c`]);

    // The read recovers with one page fewer: the second blog page is gone from index and role alike.
    slugs = ['a', 'b'];
    clock += 60_001;
    await get(app, '/sitemap.xml');
    await Bun.sleep(5);
    expect(locs(await (await get(app, '/sitemap.xml')).text())).toEqual([
      `${ORIGIN}/sitemaps/pages-1.xml`,
      `${ORIGIN}/sitemaps/blog-1.xml`,
    ]);
    expect((await get(app, '/sitemaps/blog-2.xml')).status).toBe(404);
  });
});
