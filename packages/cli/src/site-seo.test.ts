// `siteSeo` for a multi-locale site: every page once per locale with its `xhtml:link` cluster, a
// static export's prefixed pages read back unprefixed, and `seo.robots.disallow` in production.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { siteSeo } from './site-seo';

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
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

beforeEach(() => {
  resetLocaleConfig();
  clearRoutes();
});

afterEach(() => {
  clearRoutes();
  resetLocaleConfig();
});

describe('siteSeo — refusals', () => {
  test('a single-locale site gets no alternates at all', async () => {
    route('apps/web/site/precios/page.tsx');
    const seo = await siteSeo({ baseUrl: BASE, environment: 'production' });
    const xml = seo.sitemaps[0]?.xml ?? '';
    expect(xml).not.toContain('xhtml:link');
    expect(locs(xml)).toEqual([`${BASE}/precios`]);
  });

  test('outside production, disallow cannot reopen or narrow the fail-closed robots', async () => {
    const seo = await siteSeo({ baseUrl: BASE, environment: 'staging', disallow: ['/panel'] });
    expect(seo.robots).toContain('Disallow: /\n');
    expect(seo.robots).not.toContain('/panel');
  });

  test('a static report`s prefixed pages are not listed as pages of their own', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    route('apps/web/site/blog/[slug]/page.tsx', { prerender: () => ['hola'] });
    const seo = await siteSeo({
      baseUrl: BASE,
      environment: 'production',
      pagesFor: () => ['/blog/hola', '/en/blog/hola'],
    });
    expect(locs(seo.sitemaps[0]?.xml ?? '').sort()).toEqual([
      `${BASE}/blog/hola`,
      `${BASE}/en/blog/hola`,
    ]);
  });
});

describe('siteSeo — locales', () => {
  test('every page in every locale, each naming the cluster in BCP 47 plus x-default', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    route('apps/web/site/precios/page.tsx');
    const seo = await siteSeo({ baseUrl: BASE, environment: 'production' });
    const xml = seo.sitemaps[0]?.xml ?? '';
    expect(locs(xml).sort()).toEqual([`${BASE}/en/precios`, `${BASE}/precios`]);
    expect(xml).toContain(`hreflang="es-CO" href="${BASE}/precios"`);
    expect(xml).toContain(`hreflang="en" href="${BASE}/en/precios"`);
    expect(xml).toContain(`hreflang="x-default" href="${BASE}/precios"`);
  });

  test('production robots carry the configured disallow paths', async () => {
    const seo = await siteSeo({
      baseUrl: BASE,
      environment: 'production',
      disallow: ['/panel', '/api'],
    });
    expect(seo.robots).toContain('Disallow: /panel\nDisallow: /api');
    expect(seo.robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });
});
