// `seo.sitemap` through `siteSeo`: public `app/` pages the app listed, hreflang alternates for them
// as for a `site/` page, the refusals that keep a gated or unknown path out, and `<lastmod>`.
// Split from `site-seo.test.ts`, which covers the `site/` pages alone.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture's route file is root-relative.
import { join } from 'node:path';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { processRoot } from './process-root-fixture';
import { SitemapExtraInvalidError, siteSeo } from './site-seo';
import { resetLastmodCache } from './sitemap-lastmod';

const route = (file: string, patch: Partial<RouteConfig> = {}): void => {
  registerRoute({
    file,
    config: defineRoute({
      render: 'ssr',
      hydrate: 'never',
      offline: 'network-only',
      meta: () => ({ title: 'Page', description: 'a page' }),
      ...patch,
    } as Parameters<typeof defineRoute>[0]),
    component: () => 'page',
  });
};

const BASE = 'https://notificado.co';
const ROOT = processRoot(join(import.meta.dir, '..', '.site-seo-sitemap-fixture'));
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
const lastmods = (xml: string) =>
  [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);

const sitemapOf = async (extra: readonly string[], lastmod: 'none' | 'mtime' | 'build' = 'none') =>
  (
    await siteSeo({
      baseUrl: BASE,
      environment: 'production',
      sitemap: { extra, lastmod },
      root: ROOT,
    })
  ).sitemaps[0]?.xml ?? '';

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

describe('seo.sitemap.extra — refusals', () => {
  const refusal = async (extra: string): Promise<unknown> =>
    sitemapOf([extra]).then(
      () => undefined,
      (error: unknown) => error,
    );

  test('a path no route answers is refused, naming it', async () => {
    route('apps/web/app/verificar/page.tsx');
    const error = await refusal('/nothing');
    expect(error).toBeInstanceOf(SitemapExtraInvalidError);
    expect((error as SitemapExtraInvalidError).cause).toContain('"/nothing"');
  });

  test('a gated app/ page is refused — a crawler cannot open it', async () => {
    route('apps/web/app/casos/page.tsx', { policy: { permission: 'case:read' } });
    expect(((await refusal('/casos')) as SitemapExtraInvalidError).cause).toContain('policy');
  });

  test('a site/ page is refused — it is listed already', async () => {
    route('apps/web/site/precios/page.tsx', { render: 'static' });
    expect(((await refusal('/precios')) as SitemapExtraInvalidError).cause).toContain(
      'listed already',
    );
  });
});

describe('seo.sitemap.extra', () => {
  test('a public app/ page is listed beside the site/ pages; none is listed unless named', async () => {
    route('apps/web/site/precios/page.tsx', { render: 'static' });
    route('apps/web/app/verificar/page.tsx');
    route('apps/web/app/estado/page.tsx');
    expect(locs(await sitemapOf([]))).toEqual([`${BASE}/precios`]);
    expect(locs(await sitemapOf(['/verificar'])).sort()).toEqual([
      `${BASE}/precios`,
      `${BASE}/verificar`,
    ]);
  });

  test('listed per routed locale, with the hreflang cluster a site/ page gets', async () => {
    await declareLocales();
    route('apps/web/app/verificar/page.tsx');
    const xml = await sitemapOf(['/verificar']);
    expect(locs(xml).sort()).toEqual([`${BASE}/en/verificar`, `${BASE}/verificar`]);
    expect(xml).toContain(`hreflang="es-CO" href="${BASE}/verificar"`);
    expect(xml).toContain(`hreflang="en" href="${BASE}/en/verificar"`);
    expect(xml).toContain(`hreflang="x-default" href="${BASE}/verificar"`);
  });
});

describe('seo.sitemap.lastmod', () => {
  test("'none' (the default) writes no <lastmod>", async () => {
    route('apps/web/site/precios/page.tsx', { render: 'static' });
    expect(lastmods(await sitemapOf([]))).toEqual([]);
  });

  test("'mtime' reads each route file's modification time", async () => {
    const file = 'apps/web/site/precios/page.tsx';
    await Bun.write(join(ROOT, file), 'export {};\n');
    const expected = new Date(Bun.file(join(ROOT, file)).lastModified).toISOString();
    route(file, { render: 'static' });
    expect(lastmods(await sitemapOf([], 'mtime'))).toEqual([expected]);
  });

  test("'mtime' on a file that is not there writes no <lastmod> rather than a wrong one", async () => {
    route('apps/web/site/precios/page.tsx', { render: 'static' });
    expect(lastmods(await sitemapOf([], 'mtime'))).toEqual([]);
  });

  test("'build' is one timestamp for every URL, extras included", async () => {
    route('apps/web/site/precios/page.tsx', { render: 'static' });
    route('apps/web/app/verificar/page.tsx');
    const stamps = lastmods(await sitemapOf(['/verificar'], 'build'));
    expect(stamps).toHaveLength(2);
    expect(new Set(stamps).size).toBe(1);
    expect(Number.isFinite(Date.parse(stamps[0] ?? ''))).toBe(true);
  });
});
