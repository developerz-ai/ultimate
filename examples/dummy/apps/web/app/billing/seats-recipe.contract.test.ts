/**
 * contract — the link a refusal carries goes somewhere. `X_BILLING_SEATS_EXCEEDED` declares
 * `docs: 'docs://recipes/make-room-for-a-member'`, and an agent driving Postly over MCP reads that
 * URI two ways: `resources/read`, and the `docs` tool for clients that ignore resources. Both
 * answer the same markdown, naming the two tools the recipe's steps call. A renamed tool is
 * refused before this runs: `postlyMcp()` checks every step against its catalog when it builds.
 */

import { SeatsExceeded } from '@postly/core';
import { postlyMcp } from '@postly/mcp';
import { agentActor } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';

/** An agent with no grants: a recipe is visible by the tools it names, never by a permission. */
const caller = {
  actor: agentActor({ id: 'probe', orgId: 'org', roles: ['owner'] }),
  scopes: new Set<string>(),
};

let nextId = 0;
const rpc = (method: string, params: Record<string, unknown>) => {
  nextId += 1;
  return { jsonrpc: '2.0' as const, id: nextId, method, params };
};

test('the URI the seats refusal links to reads the same recipe over resources and docs', async () => {
  const uri = new SeatsExceeded({ plan: 'team', limit: 5, requested: 6 }).docs;
  expect(uri).toBe('docs://recipes/make-room-for-a-member');
  const { server } = postlyMcp();

  const read = (await server.handle(rpc('resources/read', { uri }), caller)) as {
    readonly result?: { readonly contents: readonly { readonly text: string }[] };
  };
  const body = read.result?.contents[0]?.text ?? '';
  expect(body).toContain('# Make room for a new member');
  expect(body).toContain('`seatReport`');
  expect(body).toContain('`planQuote`');

  const viaTool = (await server.handle(
    rpc('tools/call', { name: 'docs', arguments: { uri } }),
    caller,
  )) as { readonly result?: { readonly content: readonly { readonly text: string }[] } };
  expect(viaTool.result?.content[0]?.text).toBe(body);
});
