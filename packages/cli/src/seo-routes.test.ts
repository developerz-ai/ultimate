// `robots.txt` and `sitemap.xml` from a RUNNING web role, through `@ultimat3/http`'s real pipeline
// and beside the app's own pages. Reported by an app: the static export wrote both files and a
// `ROLE=web` container answered 404 for each — and an app has no way to add a non-page GET route.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { SITEMAP_MAX_URLS } from '@ultimat3/seo';
import { appRoutes } from './runtime-render';
import { seoRoutes } from './seo-routes';
import { siteSeo } from './site-seo';

const BUILD_ID = 'seo-under-test';

const serve = (env: Readonly<Record<string, string | undefined>>): ReturnType<typeof httpServer> =>
  httpServer({
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

// Every `/robots.txt` hit recomputed the whole sitemap — each dynamic route's `prerender()`
// included — and `/sitemap.xml` did it again. One answer per origin now serves both files for as
// long as the response may be cached anyway.
describe('seoRoutes memoises one answer per origin', () => {
  test('robots.txt and sitemap.xml share one enumeration; another origin gets its own', async () => {
    let enumerated = 0;
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => {
        enumerated += 1;
        return ['hello'];
      },
    });
    const server = serve({ ULTIMATE_ENV: 'production' });
    await server.fetch(new Request('https://a.example.com/robots.txt'));
    await server.fetch(new Request('https://a.example.com/sitemap.xml'));
    await server.fetch(new Request('https://a.example.com/sitemap.xml'));
    expect(enumerated).toBe(1);
    const other = await server.fetch(new Request('https://b.example.com/sitemap.xml'));
    expect(await other.text()).toContain('<loc>https://b.example.com/blog/hello</loc>');
    expect(enumerated).toBe(2);
  });

  // With no declared origin the key is the request's `Host`, which the caller picks: bounded.
  test('the memo keeps a bounded number of origins, the oldest out first', async () => {
    let enumerated = 0;
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => {
        enumerated += 1;
        return ['hello'];
      },
    });
    const server = serve({ ULTIMATE_ENV: 'production' });
    const ask = (host: string) => server.fetch(new Request(`https://${host}/sitemap.xml`));
    for (let index = 0; index < 9; index += 1) await ask(`h${index}.example.com`);
    expect(enumerated).toBe(9);
    await ask('h8.example.com');
    expect(enumerated).toBe(9);
    await ask('h0.example.com');
    expect(enumerated).toBe(10);
  });

  test('a failed enumeration is not kept: the next request asks again', async () => {
    let calls = 0;
    route('apps/web/site/blog/[slug]/page.tsx', {
      prerender: () => {
        calls += 1;
        if (calls === 1) throw new TypeError('the data store blinked');
        return ['hello'];
      },
    });
    const server = serve({ ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com' });
    expect((await server.fetch(new Request('http://x/sitemap.xml'))).status).toBe(500);
    const retried = await server.fetch(new Request('http://x/sitemap.xml'));
    expect(await retried.text()).toContain('/blog/hello');
  });
});

// s2-cli #11: past 50,000 URLs `/sitemap.xml` is an index naming its parts, and the web role served
// the index alone — every part it named was a 404. The parts come from the same memoised answer.
describe('seoRoutes serves every part a split sitemap names', () => {
  test('each <loc> in the index answers 200 with its own urlset; an unnamed part is a 404', async () => {
    let enumerated = 0;
    route('apps/web/site/p/[id]/page.tsx', {
      prerender: () => {
        enumerated += 1;
        return Array.from({ length: SITEMAP_MAX_URLS + 1 }, (_unused, index) => String(index));
      },
    });
    const server = serve(PRODUCTION);
    const index = await (await server.fetch(new Request('http://x/sitemap.xml'))).text();
    expect(index).toContain('<sitemapindex');
    const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
    expect(parts).toEqual([
      'https://www.example.com/sitemaps/1.xml',
      'https://www.example.com/sitemaps/2.xml',
    ]);
    for (const part of parts) {
      const response = await server.fetch(new Request(`http://x${new URL(part).pathname}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/xml');
      expect(await response.text()).toContain('<urlset');
    }
    expect((await server.fetch(new Request('http://x/sitemaps/3.xml'))).status).toBe(404);
    expect(enumerated).toBe(1);
  }, 60_000);
});
