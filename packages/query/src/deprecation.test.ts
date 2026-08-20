// A read on its way out has to say so on the wire, or the only way to remove it is to break
// every caller at once. The mirror of `@ultimat3/action`'s, because the two must agree.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { Deprecation } from './deprecation';
import { toQueryRoute } from './http';
import { query } from './query';
import { from } from './source';

interface Order {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const orders: readonly Order[] = [{ id: 'a', orgId: ORG }];
const reader: Actor = { ...userActor({ id: 'u1' }), permissions: ['order:read'] };
const SINCE = '2026-08-01T00:00:00Z';
const SUNSET = '2026-12-31T23:59:59Z';

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const listOrders = (deprecated?: Deprecation) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('order:read'),
    ...(deprecated === undefined ? {} : { deprecated }),
    sql: ({ orgId }) => from<Order>('orders', orders).where({ orgId }),
  }).named('listOrders');

const read = (deprecated?: Deprecation): Promise<Response> =>
  createServer({
    routes: [toQueryRoute(listOrders(deprecated))],
    config: oneProcess(),
    hooks: { authenticate: () => reader },
  }).fetch(new Request(`http://dev.test/_x/query/list-orders?orgId=${ORG}`));

describe('a deprecated read announces itself', () => {
  test('Deprecation and Sunset ride the answer', async () => {
    const response = await read({ since: SINCE, sunset: SUNSET });
    expect(response.status).toBe(200);
    expect(response.headers.get('deprecation')).toBe(`@${Date.parse(SINCE) / 1000}`);
    expect(response.headers.get('sunset')).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  test('replacedBy links the successor at the URL `client()` already derives', async () => {
    const response = await read({ since: SINCE, sunset: SUNSET, replacedBy: 'searchOrders' });
    expect(response.headers.get('link')).toBe('</_x/query/search-orders>; rel="successor-version"');
  });

  test('a read that declares nothing sends nothing', async () => {
    const response = await read();
    expect(response.headers.get('sunset')).toBeNull();
  });

  test('the descriptor publishes it', () => {
    expect(listOrders({ since: SINCE, sunset: SUNSET }).describe().deprecated).toEqual({
      since: SINCE,
      sunset: SUNSET,
    });
    expect(listOrders().describe().deprecated).toBeNull();
  });

  test('a date that cannot become a header is refused at projection', () => {
    expect(() => toQueryRoute(listOrders({ since: SINCE, sunset: 'whenever' }))).toThrow(
      /X_QUERY_DEPRECATION_INVALID/,
    );
  });
});
