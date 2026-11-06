/**
 * contract — Postly as a CLIENT of an MCP server, pointed at its OWN: `mcpTools()` over the real
 * HTTP route (`mcpHttpRoute`: bearer → agent, era headers, JSON-RPC) of `postlyMcp()`, the bytes
 * handed straight to the route instead of a socket. Locked from the live list as `x mcp lock` does,
 * then called; and the three refusals an app meets in production: the remote policy's own denial
 * (a RESULT, `isError`), a token it does not accept, and a schema that moved since the review.
 */

import { agentActor } from '@ultimat3/core';
import { mcpClient, mcpHttpRoute, mcpTools, writeToolsLock } from '@ultimat3/mcp';
import { expect, test } from '@ultimat3/testing';
import { postlyMcp } from './tools';

const URL = 'http://postly.test/mcp';
const ALLOW = ['seatReport', 'planQuote'];

interface Member {
  readonly id: string;
  readonly [column: string]: unknown;
}

/** Postly's own endpoint, with one bearer per member: what an issued agent token resolves to. */
const ownServer = (tokens: ReadonlyMap<string, Member>) => {
  const route = mcpHttpRoute({
    server: postlyMcp().server,
    resolveToken: (token) => {
      const member = tokens.get(token);
      if (member === undefined) return null;
      const actor = agentActor({
        id: member.id,
        orgId: String(member['orgId']),
        roles: [String(member['role'])],
      });
      return { actor, scopes: new Set<string>() };
    },
  });
  return (url: string, init: RequestInit) => route.handle(new Request(url, init));
};

/** `x mcp lock postly`, in memory: the live list, reviewed and written down. */
const lockOf = async (fetch: ReturnType<typeof ownServer>, token: string) => {
  const live = await mcpClient({
    name: 'postly',
    url: URL,
    dial: 'named',
    fetch,
    auth: () => ({ authorization: `Bearer ${token}` }),
  }).listTools();
  return JSON.parse(writeToolsLock(undefined, 'postly', URL, ALLOW, live)) as {
    servers: Record<string, { tools: Record<string, { inputSchema: Record<string, unknown> }> }>;
  };
};

const declare = (name: string, fetch: ReturnType<typeof ownServer>, token: string, lock: unknown) =>
  mcpTools({
    name,
    url: URL,
    dial: 'named',
    fetch,
    auth: () => ({ authorization: `Bearer ${token}` }),
    allow: ALLOW,
    policy: 'org:administer',
    lock,
  });

test('a locked tool of the app’s own server runs as an action, its answer fenced as untrusted', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' }); // Acme's owner
  const fetch = ownServer(new Map([['ada-token', ada]]));
  const { tools } = declare('postly', fetch, 'ada-token', await lockOf(fetch, 'ada-token'));

  const seats = await tools.get('seatReport')?.as(actorFor(ada), {});
  expect(seats?.isError).toBe(false);
  expect(seats?.untrusted).toStartWith('<untrusted source="mcp:postly/seatReport">');
  expect(seats?.untrusted).toContain('"remaining"');
});

test('the remote policy’s denial is a result the model reads, not a transport failure', async ({
  seed,
  actorFor,
}) => {
  const { ada, kenji } = await seed('dev').pick({
    ada: 'member:ada',
    kenji: 'member:kenji', // Acme's reader: no org:administer on the remote
  });
  const fetch = ownServer(
    new Map([
      ['ada-token', ada],
      ['kenji-token', kenji],
    ]),
  );
  const lock = await lockOf(fetch, 'ada-token');
  const { tools } = declare('postly-reader', fetch, 'kenji-token', {
    servers: { 'postly-reader': lock.servers['postly'] },
  });

  const denied = await tools.get('seatReport')?.as(actorFor(ada), {});
  expect(denied?.isError).toBe(true);
  expect(denied?.untrusted).toContain('X_FORBIDDEN');
});

test('a token the server refuses, and a schema that moved since the lock, refuse the call', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const fetch = ownServer(new Map([['ada-token', ada]]));
  const lock = await lockOf(fetch, 'ada-token');

  const stranger = declare('postly-stranger', fetch, 'stolen', {
    servers: { 'postly-stranger': lock.servers['postly'] },
  });
  await expect(stranger.tools.get('seatReport')?.as(actorFor(ada), {})).rejects.toMatchObject({
    code: 'X_MCP_REMOTE_AUTH_REQUIRED',
  });

  // What a reviewer accepted is not what the server lists any more: `planQuote` grew an argument.
  const reviewed = lock.servers['postly']?.tools['planQuote'];
  const moved = {
    servers: {
      'postly-moved': {
        ...lock.servers['postly'],
        tools: {
          ...lock.servers['postly']?.tools,
          planQuote: { ...reviewed, inputSchema: { type: 'object', properties: {} } },
        },
      },
    },
  };
  const drifted = declare('postly-moved', fetch, 'ada-token', moved);
  await expect(drifted.tools.get('seatReport')?.as(actorFor(ada), {})).rejects.toMatchObject({
    code: 'X_MCP_REMOTE_TOOL_CHANGED',
  });
});
