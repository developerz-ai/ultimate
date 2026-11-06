// `feedActivity` is a count streamed into the feed's `<Hole>`: it gives up at its own 2 s, not the
// web role's 10 s, so a slow aggregate costs the badge and never holds the page. The bound is the
// read's, sent as a transaction-local `statement_timeout` through the one `set_config` seam.

import { recordingClient, setDbClient } from '@ultimat3/db';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { afterEach, expect, test } from '@ultimat3/testing';
import { feedActivity } from './feed-activity';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

test('the badge read runs under its own 2 s bound, inside a read-only transaction', async ({
  seed,
  actorFor,
}) => {
  const pool = recordingClient().on(/pg_settings/, { rows: [{ ms: '10000' }] });
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const server = httpServer({
    routes: [toQueryRoute(feedActivity)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  // Installed after the seed: from here the entity driver and the transaction share this pool.
  setDbClient(pool);
  restore = () => setDbClient(undefined);
  const response = await server.fetch(
    new Request(`http://dev.test/_x/query/feed-activity?orgId=${ada.orgId}`),
  );
  expect(response.status).toBe(200);
  const [summary] = (await response.json()) as readonly { readonly publishedCount: number }[];
  expect(typeof summary?.publishedCount).toBe('number');

  // The role's bound read first, so 2 s is refused if it would LOOSEN it; then the count, bounded.
  expect(pool.texts).toEqual([
    'BEGIN READ ONLY',
    "select setting as ms from pg_settings where name = 'statement_timeout'",
    'select set_config($1, $2, true)',
    'select count(*) as count from "posts" where "org_id" = $1 and "status" = $2',
    'COMMIT',
  ]);
  expect(pool.statements[2]?.values).toEqual(['statement_timeout', '2000']);
});
