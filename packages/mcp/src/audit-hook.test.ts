// `onAudit`: the MCP gate's own decisions, as data, to wherever the app keeps them. Not a second
// audit path — the SAME decision the `mcp.*` log line already records, handed on after the line is
// written. Core's `AuditSink` records what a primitive DID; this records what the gate decided
// before any primitive ran (hidden, scope-denied, invalid-args, a refused token), which no
// `AuditRecord` can carry: there is no `ctx`, often no primitive, and nothing ran.

import { describe, expect, test } from 'bun:test';
import type { Logger } from '@ultimat3/core';
import { agentActor, frozenClock, structuredLogger, userActor } from '@ultimat3/core';
import { memoryRateLimitStore } from '@ultimat3/http';
import { defineAppMcp } from './app-tools';
import type { McpAuditEvent } from './audit-hook';
import { mcpAuditor } from './audit-hook';
import type { McpCaller } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const AT = '2026-10-06T09:00:00.000Z';
const clock = frozenClock(AT);
const caller: McpCaller = { actor: agentActor({ id: 'agent-1' }), scopes: new Set() };

function capture(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = structuredLogger({
    level: 'trace',
    clock,
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

const call = (name: string, id = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

const tools = [
  {
    name: 'echo',
    description: 'echoes',
    destructive: false,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    async handle() {
      return textResult('ok');
    },
  },
  {
    name: 'refund',
    description: 'refunds',
    scope: 'orders:write',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    async handle() {
      return textResult('ok');
    },
  },
];

describe('onAudit on the server: every tools/call and resources/read decision', () => {
  test('ok, hidden and scope-denied reach the hook, stamped from the clock', async () => {
    const events: McpAuditEvent[] = [];
    const server = mcpServer({ tools, clock, onAudit: (event) => void events.push(event) });
    await server.handle(call('echo'), caller);
    await server.handle(call('nope'), caller);
    await server.handle(call('refund'), caller);
    expect(events.map((event) => [event.kind, 'outcome' in event ? event.outcome : ''])).toEqual([
      ['tool-call', 'ok'],
      ['tool-call', 'hidden'],
      ['tool-call', 'scope-denied'],
    ]);
    expect(events[2]).toMatchObject({ tool: 'refund', scope: 'orders:write', caller });
    expect(events.every((event) => event.at.toISOString() === AT)).toBe(true);
  });

  test('a resources/read is its own event kind, addressed by URI', async () => {
    const events: McpAuditEvent[] = [];
    const server = mcpServer({
      resources: [
        {
          uri: 'ultimate://doc',
          name: 'doc',
          description: 'd',
          mimeType: 'application/json',
          read: () => '{}',
        },
      ],
      onAudit: (event) => void events.push(event),
    });
    await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ultimate://doc' } },
      caller,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'resource-read',
      uri: 'ultimate://doc',
      outcome: 'ok',
    });
  });

  test('tools/list is silent here exactly as it is in the log', async () => {
    const events: McpAuditEvent[] = [];
    const server = mcpServer({ tools, onAudit: (event) => void events.push(event) });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, caller);
    expect(events).toEqual([]);
  });
});

describe('onAudit on the route: the refusals before any caller exists', () => {
  const ping = (token: string | null, origin?: string): Request =>
    new Request('http://local/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

  const routeWith = (events: McpAuditEvent[], unauthenticated = 20) =>
    mcpHttpRoute({
      server: mcpServer({ clock, onAudit: (event) => void events.push(event) }),
      clock,
      rateLimitStore: memoryRateLimitStore(),
      rateLimits: { read: 100, write: 100, unauthenticated },
      resolveToken: (token) => {
        if (token === 'agent') return { actor: agentActor({ id: 'a1' }), scopes: new Set() };
        if (token === 'human') return { actor: userActor({ id: 'u1' }), scopes: new Set() };
        return null;
      },
    });

  test('missing, rejected and non-agent tokens each name their reason, status and facts', async () => {
    const events: McpAuditEvent[] = [];
    const route = routeWith(events);
    expect((await route.handle(ping(null), { address: '203.0.113.1' })).status).toBe(401);
    expect((await route.handle(ping('bad', 'https://x.example'))).status).toBe(401);
    expect((await route.handle(ping('human'))).status).toBe(403);
    expect((await route.handle(ping('agent'))).status).toBe(200);
    expect(
      events.map((event) => event.kind === 'auth-refused' && [event.reason, event.status]),
    ).toEqual([
      ['missing-token', 401],
      ['rejected-token', 401],
      ['not-an-agent', 403],
    ]);
    expect(events[0]).toMatchObject({ facts: { address: '203.0.113.1', path: '/mcp' } });
    expect(events[1]).toMatchObject({ facts: { origin: 'https://x.example' } });
    // The token itself never travels: a hook that persists events must not hold credentials.
    expect(JSON.stringify(events)).not.toContain('bad');
  });

  test('an address past its failure allowance is a throttled refusal at 429', async () => {
    const events: McpAuditEvent[] = [];
    const route = routeWith(events, 1);
    await route.handle(ping('bad'), { address: '203.0.113.2' });
    expect((await route.handle(ping('bad'), { address: '203.0.113.2' })).status).toBe(429);
    expect(events.at(-1)).toMatchObject({ kind: 'auth-refused', reason: 'throttled', status: 429 });
  });
});

describe('mcpAuditor: the hook is a destination, never a gate', () => {
  test('the log line is written whether or not a hook is installed', () => {
    const { logger, lines } = capture();
    mcpAuditor({ log: logger, clock }).toolCall({ tool: 'echo', outcome: 'ok', caller });
    expect(lines[0]).toMatchObject({ msg: 'mcp.tool-call.ok' });
  });

  test('a hook that throws changes no answer and is reported once, at error', () => {
    const { logger, lines } = capture();
    // Input handed to the code under test — the app's sink failing — never a verdict.
    const boom = new TypeError('sink down');
    const audit = mcpAuditor({
      log: logger,
      clock,
      onAudit: () => {
        throw boom;
      },
    });
    expect(() => audit.toolCall({ tool: 'echo', outcome: 'hidden', caller })).not.toThrow();
    expect(lines.map((line) => [line['msg'], line['level']])).toEqual([
      ['mcp.tool-call.hidden', 'warn'],
      ['mcp.audit-hook.failed', 'error'],
    ]);
    // Never the thrown value's text: a sink's message can name a host or a row.
    expect(JSON.stringify(lines[1])).not.toContain('sink down');
  });

  test('a hook that rejects is reported the same way', async () => {
    const { logger, lines } = capture();
    const refusal = new TypeError('x');
    mcpAuditor({ log: logger, clock, onAudit: () => Promise.reject(refusal) }).toolCall({
      tool: 'echo',
      outcome: 'ok',
      caller,
    });
    await Bun.sleep(0);
    expect(lines.at(-1)).toMatchObject({ msg: 'mcp.audit-hook.failed', event: 'tool-call' });
  });

  test('an auth refusal is logged at warn as mcp.auth.<reason>, with no token and no user agent', () => {
    const { logger, lines } = capture();
    mcpAuditor({ log: logger, clock }).authRefused('rejected-token', 401, {
      address: '203.0.113.3',
      userAgent: 'curl/8',
      origin: null,
      path: '/mcp',
    });
    expect(lines[0]).toMatchObject({
      msg: 'mcp.auth.rejected-token',
      level: 'warn',
      surface: 'mcp',
      status: 401,
      address: '203.0.113.3',
      path: '/mcp',
    });
    expect(JSON.stringify(lines[0])).not.toContain('curl');
  });
});

describe('defineAppMcp forwards onAudit to the server and the route alike', () => {
  test('one declaration, both halves', async () => {
    const events: McpAuditEvent[] = [];
    const app = defineAppMcp({
      tools: [tools[0] as (typeof tools)[number]],
      onAudit: (event) => void events.push(event),
      resolveToken: () => null,
    });
    await app.server.handle(call('echo'), caller);
    await app.route?.handle(new Request('http://local/mcp', { method: 'POST', body: '{}' }));
    expect(events.map((event) => event.kind)).toEqual(['tool-call', 'auth-refused']);
  });
});
