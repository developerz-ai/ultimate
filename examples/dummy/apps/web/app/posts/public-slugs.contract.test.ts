/**
 * contract — `publicPostSlugs` is what `/blog/:slug`'s `prerender()` enumerates, so an empty answer
 * is a blog with no article pages and no error anywhere. It was empty: the query filters and sorts
 * on `status` and `publishedAt`, and the repo read selected only `slug` and `updatedAt`, so every
 * row failed a filter over a column it did not carry.
 */

import { createServer, defineHttpConfig } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { publicPostSlugs } from './live';

test('every published post is a prerendered URL, newest first, and a draft is not', async ({
  seed,
}) => {
  // `pick` is what runs the seed; the builder alone writes nothing.
  await seed('dev').pick({ draft: 'post:draft-money' });
  const server = createServer({
    routes: [toQueryRoute(publicPostSlugs)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  const response = await server.fetch(new Request('http://dev.test/_x/query/public-post-slugs'));
  expect(response.status).toBe(200);
  const slugs = ((await response.json()) as readonly { readonly slug: string }[]).map(
    (row) => row.slug,
  );

  // The dev seed publishes three posts across both orgs and keeps one draft.
  expect(slugs).toEqual([
    'el-feed-funciona-sin-conexion',
    'nadie-formatea-una-fecha-sin-zona',
    'tenancy-is-a-column-not-a-convention',
  ]);
  expect(slugs).not.toContain('money-is-an-integer');
});
