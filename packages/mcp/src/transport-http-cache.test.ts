// Every answer `mcpHttpRoute` gives is one caller's, and `x mcp serve` runs the descriptor with no
// pipeline stage behind it to decide a cache header — so the transport states `no-store` itself.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { textResult } from './registry';
import { mcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const server = mcpServer({
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return textResult('ok');
      },
    },
  ],
});

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('mcpHttpRoute.handle: nothing it answers is storable', () => {
  const route = mcpHttpRoute({
    server,
    resolveToken: () => ({ actor: agentActor({ id: 'a' }), scopes: new Set() }),
  });
  const authed = (body: unknown) => route.handle(request(body, { authorization: 'Bearer t' }));

  test('a result is no-store', async () => {
    const res = await authed({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a notification (202) is no-store', async () => {
    const res = await authed({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a refusal before dispatch is no-store', async () => {
    const res = await route.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
