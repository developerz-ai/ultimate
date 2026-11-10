// WHO the static export's sitemap and llms.txt reads run as: nobody. Both are published files, so a
// `site/` route's `prerender()` and its `load` must read what an anonymous visitor reads — never
// what the measurement actor (in a real app, the demo owner) may read. Their in-process API calls
// authenticated as that actor, so a draft only the owner could see was listed in sitemap.xml.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clientTransport, useContext } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { from, query, resetQueries, t } from '@ultimat3/query';
import { registerQueries } from '@ultimat3/query/loader';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.prerender-seo-actor-fixture'));
const ORIGIN = 'https://example.test';

let environment: string | undefined;
beforeEach(async () => {
  environment = process.env['ULTIMATE_ENV'];
  // llms.txt pages are read only for a production build (`collectLlmsPages`).
  process.env['ULTIMATE_ENV'] = 'production';
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-seo-actor-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  if (environment === undefined) delete process.env['ULTIMATE_ENV'];
  else process.env['ULTIMATE_ENV'] = environment;
  clearRoutes();
  resetQueries();
  await rm(ROOT, { recursive: true, force: true });
});

/** Rows a signed-in actor sees and an anonymous one does not: row security, as a real app has it. */
const slugs = query({
  input: t.object({}),
  policy: allow('public'),
  sql: () =>
    from<{ slug: string }>(
      'posts',
      useContext().actor.kind === 'anonymous'
        ? [{ slug: 'published' }]
        : [{ slug: 'published' }, { slug: 'private-draft' }],
    ),
});

const readSlugs = async (): Promise<readonly string[]> => {
  const rows = await clientTransport({
    method: 'GET',
    url: `${process.env['APP_URL']}/_x/query/slugs`,
  });
  return (rows as readonly { slug: string }[]).map((row) => row.slug);
};

describe('the sitemap and llms.txt read as nobody', () => {
  // With a budget the weigh-only branch enumerates the route first, and the build shares that one
  // enumeration with the sitemap; without one only `collectSeoReads` asks.
  for (const budget of [true, false]) {
    test(`a site route's prerender() and load list only what anonymous may read (budget: ${budget})`, async () => {
      registerQueries({ slugs });
      registerRoute({
        file: 'apps/web/site/posts/[slug]/page.tsx',
        config: defineRoute({
          render: 'isr',
          revalidate: { ttl: '5m' },
          hydrate: 'never',
          offline: 'network-only',
          ...(budget ? { budget: { js: '0kb' } } : {}),
          prerender: async () => (await readSlugs()).map((slug) => ({ params: { slug } })),
          load: async () => ({ visible: (await readSlugs()).join(',') }),
          meta: ({ data }) => ({
            title: `Posts: ${(data as { visible: string }).visible}`,
            description: 'one post',
          }),
        }),
      });
      const report = await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: ORIGIN });
      expect(report.entries.get('/posts/:slug')?.map((entry) => entry.params)).toEqual([
        { slug: 'published' },
      ]);
      const pages = report.llmsPages.get('/posts/:slug') ?? [];
      expect(pages.map((page) => [page.path, page.meta?.title])).toEqual([
        ['/posts/published', 'Posts: published'],
      ]);
    });
  }
});
