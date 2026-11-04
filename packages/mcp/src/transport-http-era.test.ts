// `POST /mcp` at the transport's edge for the 2026-07-28 revision: a cross-origin page is refused
// before the token is read, a modern request's mirrored headers must equal its body, and each
// refusal travels on the status the spec names. Split from `transport-http.test.ts` for the ceiling.

import { describe, expect, test } from 'bun:test';
import { agentActor, frozenClock } from '@ultimat3/core';
import { memoryRateLimitStore } from '@ultimat3/http';
import { textResult } from './registry';
import { mcpServer } from './server';
import { mcpHttpRoute } from './transport-http';
import {
  HEADER_MISMATCH,
  MCP_MODERN_VERSIONS,
  META_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './wire';

/** The newest modern revision, as a caller now spells it. */
const MODERN = MCP_MODERN_VERSIONS[0];

const server = mcpServer({
  tools: ['echo', 'wetter-für-köln'].map((name) => ({
    name,
    description: 'echoes',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    async handle() {
      return textResult('ok');
    },
  })),
});

/** A route whose resolver counts its calls: "refused before the token is read" means 0. */
const counted = () => {
  let resolved = 0;
  const route = mcpHttpRoute({
    server,
    clock: frozenClock(1_700_000_000_000),
    rateLimitStore: memoryRateLimitStore(),
    resolveToken: (token) => {
      resolved += 1;
      return token === 'tok'
        ? { actor: agentActor({ id: 'a1' }), scopes: new Set<string>() }
        : null;
    },
  });
  return { route, resolvedCount: () => resolved };
};

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request('http://local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok', ...headers },
    body: JSON.stringify(body),
  });

const modernBody = (
  method: string,
  params: Record<string, unknown> = {},
  version: string = MODERN,
) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { ...params, _meta: { [META_PROTOCOL_VERSION]: version } },
});

/** The headers a conforming modern client sends for `body`. */
const mirrored = (method: string, name?: string): Record<string, string> => ({
  'mcp-protocol-version': MODERN,
  'mcp-method': method,
  ...(name === undefined ? {} : { 'mcp-name': name }),
});

const errorOf = async (response: Response) =>
  ((await response.json()) as { error?: { code: number; data?: Record<string, unknown> } }).error;

describe('Origin: core’s proveSameOrigin, before the token', () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  test('a cross-origin page is 403 before resolveToken runs', async () => {
    const { route, resolvedCount } = counted();
    const response = await route.handle(post(ping, { origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; cause: string; fix: string };
    expect(body.code).toBe('X_MCP_ORIGIN_REFUSED');
    expect(body.cause).toContain('http.cors.origins');
    expect(body.fix).toStartWith("curl -X POST http://local/mcp -H 'authorization: Bearer");
    expect(resolvedCount()).toBe(0);
  });

  test('the opaque origin "null" is refused, whatever is listed', async () => {
    const { route, resolvedCount } = counted();
    const everything = { listed: () => true };
    expect((await route.handle(post(ping, { origin: 'null' }), everything)).status).toBe(403);
    expect(resolvedCount()).toBe(0);
  });

  test('no Origin, the route’s own origin and a listed sibling all reach the token', async () => {
    const { route, resolvedCount } = counted();
    expect((await route.handle(post(ping))).status).toBe(200);
    expect((await route.handle(post(ping, { origin: 'http://local' }))).status).toBe(200);
    const sibling = { listed: (origin: string) => origin === 'https://admin.example' };
    const page = { origin: 'https://admin.example' };
    expect((await route.handle(post(ping, page), sibling)).status).toBe(200);
    expect(resolvedCount()).toBe(3);
  });

  test('own origin is the PUBLIC one the host resolved, not the internal request URL', async () => {
    const { route } = counted();
    const seen = { origin: 'https://www.example.com' };
    const page = { origin: 'https://www.example.com' };
    expect((await route.handle(post(ping, page), seen)).status).toBe(200);
    expect((await route.handle(post(ping, { origin: 'http://local' }), seen)).status).toBe(403);
  });

  test('a DNS-rebound name proves same-origin here — why a loopback-only host checks Host first', async () => {
    const { route } = counted();
    const rebound = new Request('http://rebound.test:3000/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok',
        origin: 'http://rebound.test:3000',
      },
      body: JSON.stringify(ping),
    });
    // The limit this rule has, stated: `x mcp serve` answers 421 before `handle` (cmd-mcp.test.ts).
    expect((await route.handle(rebound)).status).toBe(200);
  });
});

describe('mirrored headers on a modern request', () => {
  test('a conforming request passes, with a base64 Mcp-Name decoded before comparing', async () => {
    const { route } = counted();
    const plain = await route.handle(
      post(modernBody('tools/call', { name: 'echo' }), mirrored('tools/call', 'echo')),
    );
    expect(plain.status).toBe(200);
    const encoded = `=?base64?${Buffer.from('wetter-für-köln').toString('base64')}?=`;
    const named = await route.handle(
      post(modernBody('tools/call', { name: 'wetter-für-köln' }), mirrored('tools/call', encoded)),
    );
    expect(named.status).toBe(200);
  });

  test.each([
    ['MCP-Protocol-Version absent', { 'mcp-method': 'tools/list' }, 'tools/list'],
    [
      'MCP-Protocol-Version unequal',
      { ...mirrored('tools/list'), 'mcp-protocol-version': '2025-11-25' },
      'tools/list',
    ],
    ['Mcp-Method absent', { 'mcp-protocol-version': MODERN }, 'tools/list'],
    ['Mcp-Method unequal', mirrored('prompts/list'), 'tools/list'],
    ['Mcp-Name absent', mirrored('tools/call'), 'tools/call'],
    ['Mcp-Name unequal', mirrored('tools/call', 'wipe'), 'tools/call'],
    ['Mcp-Name broken base64', mirrored('tools/call', '=?base64?%%?='), 'tools/call'],
  ] as const)('%s is -32020 on 400', async (_, headers, method) => {
    const { route } = counted();
    const response = await route.handle(post(modernBody(method, { name: 'echo' }), headers));
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error?.code).toBe(HEADER_MISMATCH);
    expect(error?.data?.['code']).toBe('X_MCP_HEADER_MISMATCH');
  });

  test('a legacy body under a modern header disagrees with it', async () => {
    const { route } = counted();
    const response = await route.handle(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, mirrored('tools/list')),
    );
    expect((await errorOf(response))?.code).toBe(HEADER_MISMATCH);
  });
});

describe('the status of each answer', () => {
  test('MCP-Protocol-Version naming nothing served is -32022 on 400', async () => {
    const { route } = counted();
    const response = await route.handle(
      post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': 'garbage' }),
    );
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(error?.data?.['requested']).toBe('garbage');
  });

  test('an unserved _meta version is -32022 on 400', async () => {
    const { route } = counted();
    const headers = { ...mirrored('tools/list'), 'mcp-protocol-version': '1900-01-01' };
    const response = await route.handle(post(modernBody('tools/list', {}, '1900-01-01'), headers));
    expect(response.status).toBe(400);
    expect((await errorOf(response))?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
  });

  test('a method a modern request names and nobody answers is -32601 on 404', async () => {
    const { route } = counted();
    const response = await route.handle(post(modernBody('ping'), mirrored('ping')));
    expect(response.status).toBe(404);
    expect((await errorOf(response))?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a legacy unknown method, and a modern unknown TOOL, stay JSON-RPC errors on 200', async () => {
    const { route } = counted();
    const old = await route.handle(post({ jsonrpc: '2.0', id: 1, method: 'nope' }));
    expect(old.status).toBe(200);
    const tool = await route.handle(
      post(modernBody('tools/call', { name: 'nope' }), mirrored('tools/call', 'nope')),
    );
    expect(tool.status).toBe(200);
    expect((await errorOf(tool))?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a legacy initialize flow still answers on 200 with a legacy header', async () => {
    const { route } = counted();
    const response = await route.handle(
      post(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { 'mcp-protocol-version': '2025-06-18' },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });
});
