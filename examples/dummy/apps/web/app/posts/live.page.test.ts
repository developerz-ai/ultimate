/**
 * contract — `liveFeed` paged over its own HTTP route, end to end against the seeded database:
 * `GET /_x/query/live-feed?orgId=…&_first=2` answers the `Page` envelope, `&_after=<endCursor>`
 * continues it, and the terminal page says so. Until 2026-09 the route answered a bare array and
 * nothing else, so a query over a paged source carried its page marker ON A ROW — the shape the
 * envelope exists to make unnecessary.
 *
 * The route is mounted here exactly as `api-routes.ts` mounts it (`toQueryRoute`), with the
 * seed's member as the authenticated actor. Registration happens in `scripts/test-setup.ts`, the
 * preload — this file imports `./live`, never `api/`.
 */

import { createServer, defineHttpConfig } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import type { PostSummary } from './entity';
import { liveFeed } from './live';

interface FeedPage {
  readonly rows: readonly PostSummary[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

test('the feed pages over GET /_x/query/live-feed with _first and _after', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const server = createServer({
    routes: [toQueryRoute(liveFeed)],
    // One process, said out loud — `defineHttpConfig` refuses to guess a rate-limit scope.
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const read = async (search: string): Promise<{ status: number; body: FeedPage }> => {
    const response = await server.fetch(
      new Request(`http://dev.test/_x/query/live-feed?orgId=${ada.orgId}&${search}`),
    );
    return { status: response.status, body: (await response.json()) as FeedPage };
  };

  // Acme seeds three posts. Page one: two rows, newest first, and a cursor to continue from.
  const first = await read('_first=2');
  expect(first.status).toBe(200);
  expect(first.body.rows).toHaveLength(2);
  expect(first.body.hasNextPage).toBe(true);
  expect(typeof first.body.endCursor).toBe('string');

  // Page two is disjoint from page one, and terminal.
  const second = await read(`_first=2&_after=${first.body.endCursor}`);
  expect(second.status).toBe(200);
  expect(second.body.rows).toHaveLength(1);
  expect(second.body.hasNextPage).toBe(false);
  const seen = new Set([...first.body.rows, ...second.body.rows].map((row) => row.id));
  expect(seen.size).toBe(3);

  // Without a control the route still answers the bare array every existing client reads.
  const plain = await server.fetch(
    new Request(`http://dev.test/_x/query/live-feed?orgId=${ada.orgId}`),
  );
  expect(Array.isArray(await plain.json())).toBe(true);
});
