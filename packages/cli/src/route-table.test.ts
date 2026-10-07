// The plain `runtime.ts` routes in the served table: the routes `X_BODY_INVALID` is about, since
// an action or query validates its own input. `x routes` listed none of them, so that code's fix
// sent a reader to a table without the route it named.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import type { Route } from '@ultimat3/http';
import { resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { routeRows } from './route-table';

afterEach(() => {
  clearRoutes();
  resetActions();
  resetQueries();
});

const webhook: Route = {
  method: 'POST',
  path: '/webhooks/stripe',
  handler: () => new Response(null, { status: 204 }),
  meta: { name: 'stripeWebhook', auth: 'public' },
};

describe('unit · the route table lists runtime.ts routes', () => {
  test('a plain route is an api row declared by runtime.ts, with no primitive', () => {
    const [row] = routeRows([webhook]);
    expect(row?.json).toEqual({
      method: 'POST',
      path: '/webhooks/stripe',
      surface: 'api',
      primitive: null,
      name: 'stripeWebhook',
      auth: 'public',
      policy: null,
    });
    expect(row?.cells.at(-1)).toBe('runtime.ts routes stripeWebhook');
  });

  test('no plain routes, no rows: the default is what an app without runtime.ts serves', () => {
    expect(routeRows()).toEqual([]);
  });
});
