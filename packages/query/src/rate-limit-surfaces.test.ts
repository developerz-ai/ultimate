// One declared `rateLimit:` on a read, one bucket, every surface. It was a route meta field only
// the HTTP pipeline read, so the same read over MCP, or paged by an agent, ran unlimited. The read
// path's front half (`buildSource`) is where every surface meets; the live subscribe is realtime's
// and reaches the same spend through `spendQueryLimit`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { createServer, defineHttpConfig, resetRateLimitStore } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { spendQueryLimit } from './live';
import { query } from './query';
import { sourceFor } from './read';
import { from } from './source';

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

const ORG = '00000000-0000-4000-8000-000000000001';
const reader: Actor = { ...userActor({ id: 'u1' }), permissions: ['order:read'] };

const searchOrders = (limit = 2) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('order:read'),
    rateLimit: { limit, windowMs: 60_000 },
    mcp: { expose: true },
    sql: ({ orgId }) => from('orders', [{ id: 'a', orgId: ORG }]).where({ orgId }),
  }).named('searchOrders');

const serve = (target: ReturnType<typeof searchOrders>, defaultCapacity = 120) =>
  createServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({
      rateLimit: {
        scope: 'process',
        buckets: { default: { capacity: defaultCapacity, refillPerSecond: 0.000_1 } },
      },
    }),
    hooks: { authenticate: () => reader },
  });

const get = (app: ReturnType<typeof serve>, page = ''): Promise<Response> =>
  app.fetch(new Request(`http://dev.test/_x/query/search-orders?orgId=${ORG}${page}`));

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

// `@ultimat3/mcp`'s one projection serves a read as `sourceFor(…, { surface: 'mcp' })` then
// `execute()` (`projectable.ts`) — so that call is the MCP surface asserted here.
const viaMcp = async (target: ReturnType<typeof searchOrders>): Promise<unknown> =>
  (await sourceFor(target, { orgId: ORG }, { surface: 'mcp' })).execute();

const asReader = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: reader }), run);

describe('a declared read limit is refused after the limit on every surface', () => {
  test('HTTP: 200, 200, 429 with the read’s own numbers on the headers', async () => {
    const app = serve(searchOrders());
    const responses: Response[] = [];
    for (let i = 0; i < 3; i += 1) responses.push(await get(app));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 429]);
    expect(responses[0]?.headers.get('ratelimit-limit')).toBe('2');
    expect(responses[0]?.headers.get('ratelimit-remaining')).toBe('1');
    expect(Number(responses[2]?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  test('HTTP: a paged read spends the same bucket', async () => {
    const app = serve(searchOrders());
    const statuses = [(await get(app)).status, (await get(app, '&_first=1')).status];
    statuses.push((await get(app, '&_first=1')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('HTTP: a read declaring more than `default` is not capped at `default`', async () => {
    const app = serve(searchOrders(4), 2);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await get(app)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  test('MCP: the read tool is refused X_RATE_LIMITED on the third call', async () => {
    const target = searchOrders();
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) seen.push(await asReader(() => outcome(viaMcp(target))));
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });

  test('HTTP and MCP spend ONE bucket', async () => {
    const target = searchOrders();
    expect((await get(serve(target))).status).toBe(200);
    expect(await asReader(() => outcome(viaMcp(target)))).toBe('ok');
    expect((await get(serve(target))).status).toBe(429);
  });

  test('live subscribe: the per-subscriber spend refuses the third subscribe', async () => {
    const target = searchOrders();
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(await outcome(spendQueryLimit(target, { actor: reader })));
    }
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });
});

describe('what spends nothing', () => {
  test('an in-process server read is app code, not a caller', async () => {
    const target = searchOrders();
    for (let i = 0; i < 5; i += 1) {
      expect(await asReader(() => outcome(target({ orgId: ORG })))).toBe('ok');
    }
  });

  test('an unenforced build — the shared live window, explain — has no caller to charge', async () => {
    const target = searchOrders();
    for (let i = 0; i < 5; i += 1) {
      const build = asReader(() =>
        sourceFor(target, { orgId: ORG }, { surface: 'live', unenforced: 'shared window' }),
      );
      expect(await outcome(build)).toBe('ok');
    }
  });

  test('a read with no declared limit spends nothing on any surface', async () => {
    const open = query({
      input: t.object({ orgId: t.uuid }),
      policy: can('order:read'),
      sql: ({ orgId }) => from('orders', [{ id: 'a', orgId: ORG }]).where({ orgId }),
    }).named('openOrders');
    const ok = await outcome(spendQueryLimit(open, { actor: reader }));
    expect(ok).toBe('ok');
  });
});
