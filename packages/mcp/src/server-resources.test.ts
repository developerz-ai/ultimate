// `resources/read` reads AS the caller the gates admitted — `ctx.actor` included, as a tool's
// `handle` does (`asCallerContext`). A reader that asks `useContext()` instead of its `caller`
// argument saw whatever actor the HTTP request carried: a cookie session's user, not the token's.

import { describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, runWithContext, useContext, userActor } from '@ultimat3/core';
import type { McpCaller } from './registry';
import { mcpServer } from './server';

const token: McpCaller = { actor: agentActor({ id: 'agent_tok' }), scopes: new Set() };
const readRequest = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'resources/read',
  params: { uri: 'app://whoami' },
};

describe('resources/read', () => {
  test('a reader asking useContext() sees the token’s actor, not the request’s', async () => {
    const server = mcpServer({
      resources: [
        {
          uri: 'app://whoami',
          name: 'whoami',
          description: 'The acting actor.',
          mimeType: 'text/plain',
          read: () => useContext().actor.id,
        },
      ],
    });
    // The ambient request carries someone else — a browser session on the same origin.
    const session = ctxOf({ actor: userActor({ id: 'u_cookie', orgId: 'acme' }) });
    const answer = await runWithContext(session, () => server.handle(readRequest, token));
    const contents = (answer?.result as { contents: { text: string }[] } | undefined)?.contents;
    expect(contents?.[0]?.text).toBe('agent_tok');
  });

  test('with no request context at all, the reader still runs as the token', async () => {
    const server = mcpServer({
      resources: [
        {
          uri: 'app://whoami',
          name: 'whoami',
          description: 'The acting actor.',
          mimeType: 'text/plain',
          read: () => useContext().actor.id,
        },
      ],
    });
    const answer = await server.handle(readRequest, token);
    const contents = (answer?.result as { contents: { text: string }[] } | undefined)?.contents;
    expect(contents?.[0]?.text).toBe('agent_tok');
  });
});

describe('a resource source that throws', () => {
  const broken = () =>
    mcpServer({
      resourceSources: [
        {
          // Input to the code under test: a tenant-runbook lookup whose database is down.
          list: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.7:5432')),
        },
      ],
    });

  test('answers -32603 on resources/list and resources/read, never a rejection', async () => {
    const listed = await broken().handle(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      token,
    );
    const read = await broken().handle(readRequest, token);
    for (const answer of [listed, read]) {
      expect(answer?.result).toBeUndefined();
      expect(answer?.error?.code).toBe(-32603);
      // The source's own message names a host the caller has no business seeing.
      expect(JSON.stringify(answer)).not.toContain('ECONNREFUSED');
    }
  });

  test('both failures reach onAudit as failed', async () => {
    const seen: string[] = [];
    const server = mcpServer({
      resourceSources: [
        {
          list: () => Promise.reject(new TypeError('down')),
        },
      ],
      onAudit: (event) => {
        if (event.kind === 'resource-read') seen.push(`${event.uri} ${event.outcome}`);
      },
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, token);
    await server.handle(readRequest, token);
    expect(seen).toEqual(['resources/list failed', 'app://whoami failed']);
  });
});
