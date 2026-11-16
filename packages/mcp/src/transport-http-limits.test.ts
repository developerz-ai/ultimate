// The MCP HTTP route's limits: the body capped while it is read, the declared limits the enforced
// ones, and a body cap that is not a cap refused. Split from transport-http.test.ts.

import { describe, expect, test } from 'bun:test';
import { agentActor, frozenClock } from '@ultimat3/core';
import { memoryRateLimitStore } from '@ultimat3/http';
import { textResult } from './registry';
import { mcpServer } from './server';
import { DEFAULT_MCP_BODY_LIMIT_BYTES, MCP_RATE_LIMITS, mcpHttpRoute } from './transport-http';

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
    {
      // `destructive` is what puts a tool in the write bucket (`ToolRegistry.verbClass`), so the
      // rate-limit suite below needs one: `echo` is metered as the cheap read chatter it is.
      name: 'wipe',
      description: 'mutates',
      destructive: true,
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
    // The envelope a JSON-RPC client already parses — `id: null`, `-32600` — so nothing a
    // consumer pinned moves; what was missing is the instruction. Measured through one adopter's
    // `POST /mcp` on 2026-09-07: a box agent sending a large `promptSession` got a number and
    // no next step, while the 401, 403 and 429 beside it all carried `{ code, cause, fix }`.
    expect(payload.id).toBeNull();
    expect(payload.error.code).toBe(-32600);
    expect(payload.error.message).toContain('limit is 1024');
    expect(payload.error.data.code).toBe('X_MCP_BODY_TOO_LARGE');
    expect(payload.error.data.limit).toBe(1024);
    expect(payload.error.data.cause).toContain('limit is 1024');
    // The fix names BOTH moves — send less, or raise the cap — and names the knob where an app
    // actually builds this route, not only the bare descriptor.
    expect(payload.error.data.fix).toContain('mcpHttpRoute({ bodyLimitBytes');
    expect(payload.error.data.fix).toContain('defineAppMcp({ bodyLimitBytes');
    // Runnable as written: a NUMBER that admits what arrived, never a `<n>`. What arrived is
    // however many bytes the reader had counted when the cap tripped, so the value is read back
    // off the fix rather than pinned — what is pinned is that it is above the cap.
    const raised = /bodyLimitBytes: (\d+) \}/.exec(String(payload.error.data.fix));
    expect(Number(raised?.[1])).toBeGreaterThan(1024);
    expect(payload.error.data.fix).not.toContain('<n>');
    // A client that reads only `message` gets the same instruction.
    expect(payload.error.message).toContain(payload.error.data.fix);
  });

  test('a route built with no cap holds the declared default, and a body over it is the same 413', async () => {
    // The direct route with the knob unset — `defineAppMcp`'s forwarding of a SET knob is pinned
    // in `app-tools.test.ts`. What this pins is the default an app never chose: one byte over
    // 1 MiB is refused, and the refusal names the number so the fix line can be followed.
    const route = mcpHttpRoute(authorized);
    const res = await route.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: 'x'.repeat(DEFAULT_MCP_BODY_LIMIT_BYTES + 1),
      }),
    );
    expect(res.status).toBe(413);
    const payload = await res.json();
    expect(payload.error.data.code).toBe('X_MCP_BODY_TOO_LARGE');
    expect(payload.error.data.limit).toBe(DEFAULT_MCP_BODY_LIMIT_BYTES);
    expect(payload.error.message).toContain(`limit is ${String(DEFAULT_MCP_BODY_LIMIT_BYTES)}`);
  });

  test('a body under the cap still answers normally', async () => {
    const route = mcpHttpRoute({ ...authorized, bodyLimitBytes: 1024 });
    const res = await route.handle(
      request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * `MCP_RATE_LIMITS` and `rateLimitClass` were published on the descriptor and enforced by NOBODY
 * until 2026-08-24: `x mcp serve` mounts `route.handle` in a bare `Bun.serve`, and `defineAppMcp`
 * hands its route to the app. The type promised 20 writes a minute; the ceiling was Bun's accept
 * rate, so an agent looping on `db.query` took the pool with it.
 *
 * It is enforced HERE and not at the mount point because `rateLimitClass(body)` takes an
 * ALREADY-PARSED body and `handle` is the only thing that parses one — a limiter outside it would
 * have to read the request stream first, which is the one thing it cannot do twice.
 */
describe('mcpHttpRoute.handle: the declared limits are the enforced ones', () => {
  const agent = (id: string) => ({
    server,
    resolveToken: () => ({ actor: agentActor({ id }), scopes: new Set(['dev:read']) }),
    clock: frozenClock(1_700_000_000_000),
  });

  const toolCall = (headers: Record<string, string>): Request =>
    request(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wipe', arguments: {} } },
      headers,
    );

  test('the write bucket admits its declared burst and refuses the call after it', async () => {
    const route = mcpHttpRoute(agent('a1'));
    for (let i = 0; i < MCP_RATE_LIMITS.write; i += 1) {
      expect((await route.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(200);
    }

    const refused = await route.handle(toolCall({ authorization: 'Bearer t' }));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('3');
    const payload = await refused.json();
    // The route's OWN code, not `@ultimat3/http`'s `X_RATE_LIMITED`: the maths are shared and the
    // KNOB is not, so a fix line pointing at `rateLimit.buckets` in app.config.ts would be an
    // instruction that runs and changes nothing for this route.
    expect(payload.code).toBe('X_MCP_RATE_LIMITED');
    expect(payload.fix).toContain('rateLimits');
    // The bucket KEY never reaches the caller — it names the actor, and a 429 is provokable by
    // anyone holding a valid token.
    expect(JSON.stringify(payload)).not.toContain('a1');
  });

  test('a read is not charged the write bucket, so a handshake is never throttled by one', async () => {
    const route = mcpHttpRoute(agent('a2'));
    for (let i = 0; i < MCP_RATE_LIMITS.write; i += 1) {
      await route.handle(toolCall({ authorization: 'Bearer t' }));
    }
    expect((await route.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(429);

    const handshake = await route.handle(
      request({ jsonrpc: '2.0', id: 2, method: 'initialize' }, { authorization: 'Bearer t' }),
    );
    expect(handshake.status).toBe(200);
  });

  test('one exhausted agent does not spend another agent’s allowance', async () => {
    const store = memoryRateLimitStore();
    const noisy = mcpHttpRoute({ ...agent('noisy'), rateLimitStore: store });
    const quiet = mcpHttpRoute({ ...agent('quiet'), rateLimitStore: store });

    for (let i = 0; i <= MCP_RATE_LIMITS.write; i += 1) {
      await noisy.handle(toolCall({ authorization: 'Bearer t' }));
    }
    expect((await noisy.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(429);
    expect((await quiet.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(200);
  });

  test('the numbers are overridable, and the descriptor publishes what it enforces', async () => {
    const route = mcpHttpRoute({ ...agent('a3'), rateLimits: { read: 60, write: 1 } });
    expect(route.limits).toEqual({ read: 60, write: 1 });

    expect((await route.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(200);
    expect((await route.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(429);
  });

  test('an unauthenticated flood is refused before it can spend anyone’s bucket', async () => {
    const store = memoryRateLimitStore();
    const closed = mcpHttpRoute({ server, resolveToken: () => null, rateLimitStore: store });
    for (let i = 0; i < 50; i += 1) {
      expect((await closed.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(401);
    }

    const route = mcpHttpRoute({ ...agent('a4'), rateLimitStore: store });
    expect((await route.handle(toolCall({ authorization: 'Bearer t' }))).status).toBe(200);
  });
});

/**
 * A byte cap that is not a number is not a large cap, it is no cap: `total > NaN` is false for
 * every body, and `??` cannot screen it because `NaN` is not nullish. `readWithinLimit` refuses it
 * — but on the FIRST REQUEST an agent makes, two frames from the descriptor an author wrote, and
 * only for a request that has already got past `resolveToken`. The refusal belongs at construction,
 * where the author is standing.
 */
describe('mcpHttpRoute: a body cap that is not a cap', () => {
  const authorized = {
    server,
    resolveToken: () => ({ actor: agentActor({ id: 'a' }), scopes: new Set(['dev:read']) }),
  };

  for (const bodyLimitBytes of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
    test(`bodyLimitBytes: ${String(bodyLimitBytes)} is refused at construction`, () => {
      expect(() => mcpHttpRoute({ ...authorized, bodyLimitBytes })).toThrow(/X_INVARIANT/);
    });
  }

  test('bodyLimitBytes: 0 is a cap, exactly as @ultimat3/http already accepts one', () => {
    const route = mcpHttpRoute({ ...authorized, bodyLimitBytes: 0 });
    expect(route.path).toBe('/mcp');
  });
});
