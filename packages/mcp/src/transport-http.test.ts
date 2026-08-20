// `POST /mcp` driven from a bare `Request`, per the file's own header: the descriptor must be
// drivable in a test without `@ultimat3/http` mounting anything.

import { describe, expect, test } from 'bun:test';
import { agentActor, userActor } from '@ultimat3/core';
import { textResult } from './registry';
import { createMcpServer } from './server';
import {
  bearerToken,
  DEFAULT_MCP_BODY_LIMIT_BYTES,
  isAgentActor,
  MCP_RATE_LIMITS,
  mcpHttpRoute,
} from './transport-http';

const server = createMcpServer({
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

describe('bearerToken', () => {
  test('extracts the token from a well-formed header', () => {
    const req = request({}, { authorization: 'Bearer abc123' });
    expect(bearerToken(req)).toBe('abc123');
  });

  test('is case-insensitive on the scheme and tolerant of surrounding whitespace', () => {
    const req = request({}, { authorization: '  bearer   xyz  ' });
    expect(bearerToken(req)).toBe('xyz');
  });

  test('returns null when the header is absent or malformed', () => {
    expect(bearerToken(request({}))).toBeNull();
    expect(bearerToken(request({}, { authorization: 'Basic abc' }))).toBeNull();
    expect(bearerToken(request({}, { authorization: 'Bearer' }))).toBeNull();
  });

  test('never reads a token from the query string', () => {
    const req = new Request('http://local/mcp?token=abc', { method: 'POST' });
    expect(bearerToken(req)).toBeNull();
  });
});

describe('isAgentActor', () => {
  test('true only for kind agent', () => {
    expect(isAgentActor(agentActor({ id: 'a' }))).toBe(true);
    expect(isAgentActor(userActor({ id: 'u' }))).toBe(false);
  });
});

describe('mcpHttpRoute descriptor', () => {
  test('method, default path and limits are the documented contract', () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/mcp');
    expect(route.limits).toBe(MCP_RATE_LIMITS);
  });

  test('path is overridable for an app-scoped surface', () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null, path: '/app-mcp' });
    expect(route.path).toBe('/app-mcp');
  });

  test('rateLimitClass delegates to server.classify', () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    expect(route.rateLimitClass(body)).toBe(server.classify(body));
  });
});

describe('mcpHttpRoute.handle: authentication', () => {
  test('no bearer token is 401, before the body is even parsed', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });
    const res = await route.handle(
      new Request('http://local/mcp', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    const payload = await res.json();
    expect(payload.code).toBe('X_MCP_PROTOCOL');
  });

  test('resolveToken returning null is also 401', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });
    const res = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { authorization: 'Bearer nope' }),
    );
    expect(res.status).toBe(401);
  });

  test('malformed JSON body with a valid token is a JSON-RPC parse error, not a crash', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => ({ actor: agentActor({ id: 'a' }), scopes: new Set() }),
    });
    const res = await route.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe(-32700);
  });

  test('a resolved actor that is not kind agent is 403, never silently upgraded', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => ({ actor: userActor({ id: 'u' }), scopes: new Set() }),
    });
    const res = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.code).toBe('X_MCP_PROTOCOL');
  });
});

describe('mcpHttpRoute.handle: successful calls', () => {
  const route = mcpHttpRoute({
    server,
    resolveToken: () => ({
      actor: agentActor({ id: 'a' }),
      scopes: new Set(['dev:read']),
      role: 'dev',
    }),
  });

  test('a request gets 200 with the JSON-RPC result', async () => {
    const res = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.serverInfo).toBeDefined();
  });

  test('a notification (no id) gets 202 with an empty body', async () => {
    const res = await route.handle(
      request({ jsonrpc: '2.0', method: 'notifications/ping' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('a malformed envelope with a null id is a 400, an application error is still 200', async () => {
    const malformed = await route.handle(
      request({ not: 'jsonrpc' }, { authorization: 'Bearer t' }),
    );
    expect(malformed.status).toBe(400);

    const unknownMethod = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'nope' }, { authorization: 'Bearer t' }),
    );
    expect(unknownMethod.status).toBe(200);
    const payload = await unknownMethod.json();
    expect(payload.error.code).toBe(-32601);
  });
});

describe('an unauthenticated caller learns nothing about its own request', () => {
  /** The oracle: two requests differing only in body shape must be indistinguishable. */
  const malformed = (headers: Record<string, string>): Request =>
    new Request('http://local/mcp', { method: 'POST', headers, body: '{' });

  // Measured: `Bearer garbage` with `{` answered `400 parse error` and with valid JSON answered
  // `401` — the body was parsed before the token was resolved.
  test('a rejected token answers 401 whether or not the JSON parses', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });

    const bad = await route.handle(malformed({ authorization: 'Bearer garbage' }));
    const good = await route.handle(
      request(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          authorization: 'Bearer garbage',
        },
      ),
    );

    expect(bad.status).toBe(401);
    expect(good.status).toBe(401);
    expect(await bad.text()).toBe(await good.text());
  });

  test('a non-agent actor answers the same way for either body', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => ({ actor: userActor({ id: 'u1' }), scopes: new Set<string>() }),
    });

    const bad = await route.handle(malformed({ authorization: 'Bearer t' }));
    const good = await route.handle(
      request(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          authorization: 'Bearer t',
        },
      ),
    );

    expect(bad.status).toBe(good.status);
    expect(await bad.text()).toBe(await good.text());
  });

  // The parse error still exists — it is what an authenticated agent gets for a broken payload.
  test('an authenticated agent still gets the parse error', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => ({ actor: agentActor({ id: 'a1' }), scopes: new Set<string>() }),
    });

    const res = await route.handle(malformed({ authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not valid JSON');
  });
});

/**
 * `await request.json()` on a bare `Request` is governed by Bun's 128 MiB default and by nothing
 * else: this descriptor never passes through `@ultimat3/http`'s pipeline, so `bodyLimitBytes` and
 * the counting reader that enforces it were both absent. An app mounting `defineAppMcp`'s route
 * inherits that with a real token behind it.
 */
describe('mcpHttpRoute.handle: the body is capped while it is read', () => {
  const authorized = {
    server,
    resolveToken: () => ({ actor: agentActor({ id: 'a' }), scopes: new Set(['dev:read']) }),
  };

  test('the default cap is the same 1 MiB @ultimat3/http declares', () => {
    expect(DEFAULT_MCP_BODY_LIMIT_BYTES).toBe(1_048_576);
  });

  test('a body over the cap is 413 and is never parsed', async () => {
    const route = mcpHttpRoute({ ...authorized, bodyLimitBytes: 1024 });
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { pad: 'x'.repeat(4096) },
    });
    const res = await route.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: oversized,
      }),
    );
    expect(res.status).toBe(413);
    const payload = await res.json();
    expect(payload.error.message).toContain('1024');
  });

  test('a body under the cap still answers normally', async () => {
    const route = mcpHttpRoute({ ...authorized, bodyLimitBytes: 1024 });
    const res = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(200);
  });
});
