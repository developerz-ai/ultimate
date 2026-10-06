// `resolveToken(token, facts)`: the resolver is told HOW the request arrived — the host's address,
// the user agent, the browser `Origin`, the path — so an app can bind a token to a network or refuse
// a browser origin. Frozen and typed, never the raw `Headers`: a resolver handed the headers would
// read `x-forwarded-for` itself and trust a hop the host never declared.

import { describe, expect, test } from 'bun:test';
import { agentActor, frozenClock } from '@ultimat3/core';
import { memoryRateLimitStore } from '@ultimat3/http';
import type { McpRequestFacts } from './index';
import { createMcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const server = createMcpServer();

const ping = (headers: Record<string, string> = {}, url = 'http://local/mcp'): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

const routeSeeing = (decide: (facts: McpRequestFacts) => boolean) => {
  const seen: McpRequestFacts[] = [];
  const route = mcpHttpRoute({
    server,
    clock: frozenClock(1_700_000_000_000),
    rateLimitStore: memoryRateLimitStore(),
    resolveToken: (token, facts) => {
      seen.push(facts);
      return token === 'tok' && decide(facts)
        ? { actor: agentActor({ id: 'a1' }), scopes: new Set<string>() }
        : null;
    },
  });
  return { route, seen };
};

describe('resolveToken receives the request facts', () => {
  test('the resolver is handed the same facts, frozen', async () => {
    const { route, seen } = routeSeeing(() => true);
    const response = await route.handle(ping({ 'user-agent': 'agent/1' }), {
      address: '203.0.113.9',
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      address: '203.0.113.9',
      userAgent: 'agent/1',
      origin: null,
      path: '/mcp',
    });
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  test('an app refuses a browser origin: the same 401 as an unknown token', async () => {
    const { route } = routeSeeing((facts) => facts.origin === null);
    const refused = await route.handle(ping({ origin: 'https://evil.example' }));
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe('X_MCP_PROTOCOL');
    expect((await route.handle(ping())).status).toBe(200);
  });

  test('an app binds a token to a network by the host-resolved address', async () => {
    const { route } = routeSeeing((facts) => facts.address?.startsWith('10.') === true);
    expect((await route.handle(ping(), { address: '10.0.0.8' })).status).toBe(200);
    expect((await route.handle(ping(), { address: '203.0.113.9' })).status).toBe(401);
  });
});
