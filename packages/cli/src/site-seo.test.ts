// `siteSeo` for a multi-locale site: every page once per locale with its `xhtml:link` cluster, a
// static export's prefixed pages read back unprefixed, and `seo.robots.disallow` in production.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture's catalog module is root-relative.
import { join } from 'node:path';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { processRoot } from './process-root-fixture';
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
const ROOT = processRoot(join(import.meta.dir, '..', '.site-seo-fixture'));

/**
 * What an app writes: `defineCatalogs()` in its catalog module, which `siteSeo` reads through
 * `@ultimat3/i18n`'s one reader — the ambient `configureLocales` beside it is the renderer's.
 */
const declareLocales = async (): Promise<void> => {
  await Bun.write(
    join(ROOT, 'packages/i18n/src/index.ts'),
    "import { defineCatalogs } from '@ultimat3/i18n';\n" +
      "export const catalogs = defineCatalogs({ default: 'es-co', locales: { 'es-co': {}, en: {} } });\n",
  );
  configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
};
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

beforeEach(() => {
  resetLocaleConfig();
  clearRoutes();
});

afterEach(async () => {
  clearRoutes();
  resetLocaleConfig();
  await rm(ROOT, { recursive: true, force: true });
});

describe('siteSeo — refusals', () => {
  test('a single-locale site gets no alternates at all', async () => {
    route('apps/web/site/precios/page.tsx');
    const seo = await siteSeo({ baseUrl: BASE, environment: 'production', root: ROOT });
    const xml = seo.sitemaps[0]?.xml ?? '';
    expect(xml).not.toContain('xhtml:link');
    expect(locs(xml)).toEqual([`${BASE}/precios`]);
  });

  test('outside production, disallow cannot reopen or narrow the fail-closed robots', async () => {
    const seo = await siteSeo({
      baseUrl: BASE,
      environment: 'staging',
      disallow: ['/panel'],
      root: ROOT,
    });
    expect(seo.robots).toContain('Disallow: /\n');
    expect(seo.robots).not.toContain('/panel');
  });

  test('a static report`s prefixed pages are not listed as pages of their own', async () => {
    await declareLocales();
    route('apps/web/site/blog/[slug]/page.tsx', { prerender: () => ['hola'] });
    const seo = await siteSeo({
      baseUrl: BASE,
      environment: 'production',
      root: ROOT,
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
    await declareLocales();
    route('apps/web/site/precios/page.tsx');
    const seo = await siteSeo({ baseUrl: BASE, environment: 'production', root: ROOT });
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
      root: ROOT,
    });
    expect(seo.robots).toContain('Disallow: /panel\nDisallow: /api');
    expect(seo.robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });
});
