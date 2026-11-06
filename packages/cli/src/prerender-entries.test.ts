// The static export's sitemap reads each `site/` route's pages off the build's ONE enumeration.
// What a `--shape blog` app hit (2026-11-06): `siteSeo` asked `/posts/:slug`'s `prerender()` again
// after `prerenderSite` had closed its in-process API scope, so a `prerender()` reading the app's
// own query failed the whole export with X_CLIENT_TRANSPORT_FAILED.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clientTransport } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { from, query, registerQueries, resetQueries, t } from '@ultimat3/query';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';
import { siteSeo } from './site-seo';

const ROOT = processRoot(join(import.meta.dir, '..', '.prerender-entries-fixture'));
const ORIGIN = 'https://example.test';

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-entries-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  clearRoutes();
  resetQueries();
  await rm(ROOT, { recursive: true, force: true });
});

/** A public `isr` post page whose `prerender()` lists slugs over the app's own HTTP API. */
const postPage = (calls: { count: number }, budget: boolean): void => {
  registerQueries({
    slugs: query({
      input: t.object({}),
      policy: allow('public'),
      sql: () => from<{ slug: string }>('posts', [{ slug: 'hola' }, { slug: 'adios' }]),
    }),
  });
  registerRoute({
    file: 'apps/web/site/posts/[slug]/page.tsx',
    config: defineRoute({
      render: 'isr',
      revalidate: { ttl: '5m' },
      hydrate: 'never',
      offline: 'network-only',
      ...(budget ? { budget: { js: '0kb' } } : {}),
      prerender: async () => {
        calls.count += 1;
        const response = await clientTransport({
          method: 'GET',
          url: `${process.env['APP_URL']}/_x/query/slugs`,
        });
        return (response as readonly { slug: string }[]).map((row) => ({
          params: { slug: row.slug },
          lastmod: '2025-10-01T00:00:00Z',
        }));
      },
      meta: () => ({ title: 'Post', description: 'one post' }),
    }),
  });
};

describe('the static export enumerates each site/ route once, inside its own scope', () => {
  for (const budget of [true, false]) {
    test(`a prerender() reading the app's API is answered, and siteSeo reuses it (budget: ${budget})`, async () => {
      const calls = { count: 0 };
      postPage(calls, budget);
      const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: ORIGIN });
      expect(report.entries.get('/posts/:slug')?.map((entry) => entry.params)).toEqual([
        { slug: 'hola' },
        { slug: 'adios' },
      ]);
      const before = calls.count;
      // After the build: no scope, no server. The sitemap must not need either.
      const seo = await siteSeo({
        baseUrl: report.origin,
        environment: 'production',
        root: ROOT,
        entries: report.entries,
      });
      expect(calls.count).toBe(before);
      expect(seo.sitemaps[0]?.xml).toContain(`<loc>${ORIGIN}/posts/hola</loc>`);
      expect(seo.sitemaps[0]?.xml).toContain('<lastmod>2025-10-01T00:00:00.000Z</lastmod>');
    });
  }

  test('a route with no prerender() is not enumerated, so an app with none starts no database', async () => {
    registerRoute({
      file: 'apps/web/site/page.tsx',
      config: defineRoute({
        render: 'static',
        hydrate: 'never',
        offline: 'precache',
        meta: () => ({ title: 'Home', description: 'the landing page' }),
      }),
    });
    const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: ORIGIN });
    expect([...report.entries.keys()]).toEqual([]);
  });
});
