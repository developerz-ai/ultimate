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
