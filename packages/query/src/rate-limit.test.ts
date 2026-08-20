// A read could not be throttled at all: `QueryDef` had no `rateLimit` and `toQueryRoute` set no
// bucket, so every `GET /_x/query/*` fell to `default` — 120 burst, 2/s per actor. One
// authenticated caller could hold 120 cross-tenant aggregates in flight, then 2/s, forever.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig, toBucket } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import type { QueryRateLimit } from './query';
import { query } from './query';
import { from } from './source';

interface Order {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const orders: readonly Order[] = [{ id: 'a', orgId: ORG }];
const reader: Actor = { ...userActor({ id: 'u1' }), permissions: ['order:read'] };

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const searchOrders = (rateLimit?: QueryRateLimit) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('order:read'),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    sql: ({ orgId }) => from<Order>('orders', orders).where({ orgId }),
  }).named('searchOrders');

const serve = (rateLimit?: QueryRateLimit) =>
  createServer({
    routes: [toQueryRoute(searchOrders(rateLimit))],
    config: oneProcess(),
    hooks: { authenticate: () => reader },
  });

const read = (server: ReturnType<typeof serve>): Promise<Response> =>
  server.fetch(new Request(`http://dev.test/_x/query/search-orders?orgId=${ORG}`));

async function drain(server: ReturnType<typeof serve>, count: number): Promise<readonly number[]> {
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) out.push((await read(server)).status);
  return out;
}

describe('a query rate limit is enforced, not merely declarable', () => {
  test('the fourth read of a limit: 3 query is refused', async () => {
    const statuses = await drain(serve({ limit: 3, windowMs: 600_000 }), 4);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  test('the limit header states the declared number, so a client reads what is enforced', async () => {
    const response = await read(serve({ limit: 3, windowMs: 600_000 }));
    expect(response.headers.get('ratelimit-limit')).toBe('3');
  });

  test('a read that declares nothing keeps the default bucket', async () => {
    const statuses = await drain(serve(), 10);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  test('the route carries the NAME and the NUMBERS — a name alone falls through to default', () => {
    const meta = toQueryRoute(searchOrders({ limit: 3, windowMs: 600_000 })).meta;
    expect(meta.rateLimit).toBe('searchOrders');
    // Converted by `@ultimat3/http`'s `toBucket`, the same one the action route uses: a second
    // conversion here could publish numbers the limiter refuses.
    expect(meta.rateLimitBucket).toEqual(toBucket('searchOrders', { limit: 3, windowMs: 600_000 }));
  });

  test('a pair the limiter cannot run on is refused at projection', () => {
    expect(() => toQueryRoute(searchOrders({ limit: 5, windowMs: 0 }))).toThrow(
      /X_RATE_LIMIT_INVALID/,
    );
  });

  test('the descriptor publishes the declaration', () => {
    expect(searchOrders({ limit: 3, windowMs: 600_000 }).describe().rateLimit).toEqual({
      limit: 3,
      windowMs: 600_000,
    });
    expect(searchOrders().describe().rateLimit).toBeNull();
  });
});
