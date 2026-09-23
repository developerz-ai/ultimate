/**
 * contract — `postById` is what `/posts/{id}` loads. It ordered by `createdAt`, a column its
 * `PostView` rows do not carry, and when `from()` began refusing that (X_QUERY_COLUMN_UNSELECTED)
 * every post page answered 500 while every contract test stayed green — only the e2e step saw it.
 */

import { createServer, defineHttpConfig } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { postById } from './live';

test('a member reads one of their org’s posts, with its comments', async ({ seed, actorFor }) => {
  const { ada, post } = await seed('dev').pick({ ada: 'member:ada', post: 'post:tenancy' });
  const server = createServer({
    routes: [toQueryRoute(postById)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const response = await server.fetch(
    new Request(`http://dev.test/_x/query/post-by-id?orgId=${ada.orgId}&postId=${post.id}`),
  );
  expect(response.status).toBe(200);
  const rows = (await response.json()) as readonly {
    readonly id: string;
    readonly comments: unknown[];
  }[];
  expect(rows.map((row) => row.id)).toEqual([post.id]);
  expect(Array.isArray(rows[0]?.comments)).toBe(true);
});
