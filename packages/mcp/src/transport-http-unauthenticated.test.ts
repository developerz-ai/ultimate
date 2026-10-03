// Token guessing is metered per ADDRESS, before `resolveToken`: an address that has failed its
// allowance is refused without asking the credential store — a valid guess included, so the 429
// says nothing about the token. The address is the host's (`seen.address`); an authenticated
// agent never spends this bucket.

import { describe, expect, test } from 'bun:test';
import { agentActor, frozenClock, isUltimateError } from '@ultimat3/core';
import { memoryRateLimitStore, type RateLimitStore } from '@ultimat3/http';
import { createMcpServer } from './server';
import { MCP_UNAUTHENTICATED_LIMIT, mcpHttpRoute } from './transport-http';

const server = createMcpServer();
const GOOD = 'good-token';

/** A route whose `resolveToken` counts its calls, accepting exactly `GOOD`. */
const counted = (rateLimits?: { read: number; write: number; unauthenticated?: number }) => {
  const calls = { count: 0 };
  const route = mcpHttpRoute({
    server,
    clock: frozenClock(1_700_000_000_000),
    rateLimitStore: memoryRateLimitStore(),
    ...(rateLimits === undefined ? {} : { rateLimits }),
    resolveToken: (token) => {
      calls.count += 1;
      return token === GOOD ? { actor: agentActor({ id: 'a1' }), scopes: new Set<string>() } : null;
    },
  });
  return { route, calls };
};

const ping = (token: string | null): Request =>
  new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

const from = (address: string) => ({ address });

describe('failed authentication is metered per address, before resolveToken', () => {
  test('past the allowance an address is refused 429 and the credential store is not asked', async () => {
    const { route, calls } = counted();
    for (let i = 0; i < MCP_UNAUTHENTICATED_LIMIT; i += 1) {
      expect((await route.handle(ping(`guess-${i}`), from('203.0.113.7'))).status).toBe(401);
    }
    expect(calls.count).toBe(MCP_UNAUTHENTICATED_LIMIT);

    const refused = await route.handle(ping('guess-next'), from('203.0.113.7'));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const payload = (await refused.json()) as Record<string, string>;
    expect(payload['code']).toBe('X_MCP_RATE_LIMITED');
    expect(payload['fix']).toContain('unauthenticated');
    expect(JSON.stringify(payload)).not.toContain('203.0.113.7');
    // A VALID guess from the exhausted address learns nothing either: it never reaches the store.
    expect((await route.handle(ping(GOOD), from('203.0.113.7'))).status).toBe(429);
    expect(calls.count).toBe(MCP_UNAUTHENTICATED_LIMIT);
  });

  test('a missing Authorization header is a failed attempt too', async () => {
    const { route } = counted({ read: 120, write: 20, unauthenticated: 2 });
    expect((await route.handle(ping(null), from('203.0.113.8'))).status).toBe(401);
    expect((await route.handle(ping(null), from('203.0.113.8'))).status).toBe(401);
    expect((await route.handle(ping(null), from('203.0.113.8'))).status).toBe(429);
  });

  test('another address keeps its own allowance', async () => {
    const { route } = counted({ read: 120, write: 20, unauthenticated: 1 });
    await route.handle(ping('x'), from('203.0.113.9'));
    expect((await route.handle(ping('x'), from('203.0.113.9'))).status).toBe(429);
    expect((await route.handle(ping('x'), from('198.51.100.1'))).status).toBe(401);
    expect((await route.handle(ping(GOOD), from('198.51.100.2'))).status).toBe(200);
  });

  test('an authenticated agent never spends it', async () => {
    const { route } = counted({ read: 120, write: 20, unauthenticated: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect((await route.handle(ping(GOOD), from('203.0.113.10'))).status).toBe(200);
    }
    expect((await route.handle(ping('x'), from('203.0.113.10'))).status).toBe(401);
  });

  test('with no address from the host there is nothing to key on, so nothing is pooled', async () => {
    const { route } = counted({ read: 120, write: 20, unauthenticated: 1 });
    for (let i = 0; i < 3; i += 1) expect((await route.handle(ping('x'))).status).toBe(401);
    expect((await route.handle(ping(GOOD))).status).toBe(200);
  });

  test('an allowance that cannot be enforced is refused at construction', () => {
    for (const unauthenticated of [0, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      let thrown: unknown;
      try {
        counted({ read: 120, write: 20, unauthenticated });
      } catch (error) {
        thrown = error;
      }
      if (!isUltimateError(thrown)) expect.unreachable('expected a coded refusal');
      // The same screen and code `bodyLimitBytes` gets one option over.
      expect(thrown.code).toBe('X_INVARIANT');
      expect(thrown.cause).toContain('rateLimits.unauthenticated');
    }
  });

  test('the pre-check reads: N authenticated calls take nothing under the failure key', async () => {
    const backing = memoryRateLimitStore();
    const failureTakes: string[] = [];
    const store: RateLimitStore = {
      scope: backing.scope,
      take: (key, bucket, cost, nowMs) => {
        if (key.startsWith('mcp:unauthenticated|')) failureTakes.push(key);
        return backing.take(key, bucket, cost, nowMs);
      },
      peek: (key, bucket, nowMs) => backing.peek(key, bucket, nowMs),
      reset: (key) => backing.reset(key),
    };
    const route = mcpHttpRoute({
      server,
      rateLimitStore: store,
      resolveToken: () => ({ actor: agentActor({ id: 'a1' }), scopes: new Set<string>() }),
    });
    for (let i = 0; i < 10; i += 1) {
      expect((await route.handle(ping(GOOD), from('203.0.113.11'))).status).toBe(200);
    }
    expect(failureTakes).toEqual([]);
  });
});
