// `robots.txt` and `sitemap.xml` from a RUNNING web role, through `@ultimat3/http`'s real pipeline
// and beside the app's own pages. Reported by an app: the static export wrote both files and a
// `ROLE=web` container answered 404 for each — and an app has no way to add a non-page GET route.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { appRoutes } from './runtime-render';
import { seoRoutes } from './seo-routes';
import { siteSeo } from './site-seo';

const BUILD_ID = 'seo-under-test';

const serve = (
  env: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof createServer> =>
  createServer({
    routes: [...seoRoutes({ env }), ...appRoutes({ buildId: BUILD_ID })],
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

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

/** A small site with one of each thing a sitemap has to decide about. */
const site = (): void => {
  route('apps/web/site/page.tsx');
  route('apps/web/site/pricing/page.tsx');
  route('apps/web/site/blog/[slug]/page.tsx', { prerender: () => ['hello', 'world'] });
  // `meta` says noindex: the page asks crawlers to stay away, so the sitemap must not invite them.
  route('apps/web/site/thanks/page.tsx', {
    meta: async () => ({
      title: 'Thanks',
      description: 'after the form',
      robots: { index: false },
    }),
  });
  // Behind a policy: not public, whatever surface it sits on.
  route('apps/web/site/members/page.tsx', {
    render: 'ssr',
    policy: { permission: 'members:read' },
  });
  route('apps/web/app/dashboard/page.tsx', { render: 'ssr' });
};

const PRODUCTION = { ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com/' };

beforeEach(() => {
  clearRoutes();
});

afterEach(() => {
  clearRoutes();
});

describe('siteSeo', () => {
  test('the sitemap lists every public site page, absolute, and nothing else', async () => {
    site();
    const seo = await siteSeo({ baseUrl: 'https://www.example.com', environment: 'production' });
    const [sitemap] = seo.sitemaps;
    expect(seo.sitemaps).toHaveLength(1);
    expect(sitemap?.path).toBe('/sitemap.xml');
    const locs = [...(sitemap?.xml ?? '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual([
      'https://www.example.com',
      'https://www.example.com/blog/hello',
      'https://www.example.com/blog/world',
      'https://www.example.com/pricing',
    ]);
  });

  test('robots allows the crawl and names the absolute sitemap in production', async () => {
    site();
    const { robots } = await siteSeo({
      baseUrl: 'https://www.example.com',
      environment: 'production',
    });
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://www.example.com/sitemap.xml');
    expect(robots).not.toContain('Disallow: /\n');
  });

  test('anything but production disallows everything and advertises no sitemap', async () => {
    site();
    const { robots } = await siteSeo({
      baseUrl: 'https://www.example.com',
      environment: 'staging',
    });
    expect(robots).toContain('Disallow: /');
    expect(robots).not.toContain('Sitemap:');
  });

  // The static export's half: a dynamic route contributes exactly the pages the build EMITTED,
  // which the caller hands in, rather than a second call to `prerender()`.
  test('pagesFor replaces prerender() for the dynamic routes, and only for them', async () => {
    site();
    const seo = await siteSeo({
      baseUrl: 'https://www.example.com',
      environment: 'production',
      pagesFor: (path) => (path === '/blog/:slug' ? ['/blog/hello'] : []),
    });
    const xml = seo.sitemaps[0]?.xml ?? '';
    expect(xml).toContain('<loc>https://www.example.com/blog/hello</loc>');
    expect(xml).not.toContain('/blog/world');
    expect(xml).toContain('<loc>https://www.example.com/pricing</loc>');
  });
});

describe('seoRoutes, served by the web role', () => {
  test('GET /robots.txt and GET /sitemap.xml answer, from APP_URL, beside the pages', async () => {
    site();
    const server = serve(PRODUCTION);

    const robots = await server.fetch(new Request('http://10.0.0.7:3000/robots.txt'));
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toContain('text/plain');
    expect(await robots.text()).toContain('Sitemap: https://www.example.com/sitemap.xml');

    const sitemap = await server.fetch(new Request('http://10.0.0.7:3000/sitemap.xml'));
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    const xml = await sitemap.text();
    expect(xml).toContain('<loc>https://www.example.com/pricing</loc>');
    expect(xml).not.toContain('10.0.0.7');

    // And the pages are still the pages.
    expect((await server.fetch(new Request('http://10.0.0.7:3000/pricing'))).status).toBe(200);
  });

  test('a non-production process serves a robots.txt that refuses the crawl', async () => {
    site();
    const server = serve({ ULTIMATE_ENV: 'staging', APP_URL: 'https://staging.example.com' });
    const body = await (await server.fetch(new Request('http://x/robots.txt'))).text();
    expect(body).toContain('Disallow: /');
    expect(body).not.toContain('Sitemap:');
  });

  test('with no APP_URL the static build`s SITE_ORIGIN is the origin, then the request`s', async () => {
    site();
    const fromSite = serve({ ULTIMATE_ENV: 'production', SITE_ORIGIN: 'https://site.example.com' });
    expect(await (await fromSite.fetch(new Request('http://x/sitemap.xml'))).text()).toContain(
      '<loc>https://site.example.com</loc>',
    );
    const fromRequest = serve({ ULTIMATE_ENV: 'production' });
    expect(
      await (await fromRequest.fetch(new Request('https://req.example.com/sitemap.xml'))).text(),
    ).toContain('<loc>https://req.example.com</loc>');
  });
});
