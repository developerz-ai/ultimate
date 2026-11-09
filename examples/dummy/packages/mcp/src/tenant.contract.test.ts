/**
 * contract — one person, two orgs, ONE token, over Postly's own MCP endpoint (`mcpHttpRoute` around
 * `postlyMcp({ memberships })`: bearer → the person, JSON-RPC over a real `Request`). Every call
 * names its org as `org`; the org a call names is the only one it sees; an org the person is not in
 * answers as a hidden tool; and the per-caller catalog (`./quotes.ts`) lists each org's own
 * `quote_<plan>` tools.
 */

import { agentActor } from '@ultimat3/core';
import { mcpHttpRoute } from '@ultimat3/mcp';
import { expect, test } from '@ultimat3/testing';
import type { PostlyMembership } from './tenants';
import { postlyMcp } from './tools';

interface Row {
  readonly id: string;
  readonly [column: string]: unknown;
}

const membershipOf = (member: Row): PostlyMembership => ({
  orgId: String(member['orgId']),
  memberId: member.id,
  role: member['role'] as PostlyMembership['role'],
});

/** The app's own endpoint: one token, resolving to a person who is Ada in Acme and Mara in Tinta. */
const endpoint = (memberships: readonly PostlyMembership[]) => {
  const person = agentActor({ id: 'person:ada-mara' });
  const route = mcpHttpRoute({
    server: postlyMcp({ memberships: () => memberships }).server,
    resolveToken: (token) => (token === 'one-token' ? { actor: person, scopes: new Set() } : null),
  });
  let id = 0;
  return async (method: string, params?: Record<string, unknown>) => {
    id += 1;
    const response = await route.handle(
      new Request('http://postly.test/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer one-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      }),
    );
    return (await response.json()) as {
      result?: { content?: { text: string }[]; tools?: { name: string }[] };
      error?: { code: number; message: string };
    };
  };
};

const textOf = (answer: { result?: { content?: { text: string }[] } }) =>
  answer.result?.content?.[0]?.text ?? '';

test('one token drives Acme then Tinta: each call reads only the org it names', async ({
  seed,
}) => {
  const { ada, mara, acmePost, tintaPost } = await seed('dev').pick({
    ada: 'member:ada', // Acme's owner
    mara: 'member:mara', // Tinta's owner
    acmePost: 'post:tenancy',
    tintaPost: 'post:offline', // Tinta's
  });
  const rpc = endpoint([membershipOf(ada), membershipOf(mara)]);
  const read = (org: string, post: Row) =>
    rpc('tools/call', {
      name: 'postById',
      arguments: { org, orgId: post['orgId'], postId: post.id },
    });

  const tenants = JSON.parse(textOf(await rpc('tools/call', { name: 'list_tenants' })));
  expect(tenants.tenants.map((tenant: { value: string }) => tenant.value).sort()).toEqual(
    [String(ada['orgId']), String(mara['orgId'])].sort(),
  );

  const acme = String(ada['orgId']);
  const tinta = String(mara['orgId']);
  expect(textOf(await read(acme, acmePost))).toContain(acmePost.id);
  expect(textOf(await read(tinta, tintaPost))).toContain(tintaPost.id);
  // Acting in Acme, Tinta's row is refused by the same policy every surface reads.
  const crossed = textOf(await read(acme, tintaPost));
  expect(crossed).not.toContain(String(tintaPost['title']));
  expect(crossed).toStartWith('X_FORBIDDEN');
});

test('a call naming no org is X_MCP_TENANT_REQUIRED; a foreign org answers as a hidden tool', async ({
  seed,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const rpc = endpoint([membershipOf(ada)]);

  const unnamed = textOf(await rpc('tools/call', { name: 'seatReport', arguments: {} }));
  expect(unnamed).toContain('X_MCP_TENANT_REQUIRED');
  expect(unnamed).toContain('list_tenants({})');

  const foreign = await rpc('tools/call', {
    name: 'seatReport',
    arguments: { org: '00000000-0000-7000-8000-000000000000' },
  });
  const hidden = await rpc('tools/call', {
    name: 'noSuchTool',
    arguments: { org: String(ada['orgId']) },
  });
  expect(foreign.error?.code).toBe(-32601);
  // The ids differ by request; the answer does not.
  expect(JSON.stringify(foreign.error).replace('seatReport', 'noSuchTool')).toBe(
    JSON.stringify(hidden.error),
  );
});

test('the catalog is per org: tools/list holds every org’s quotes, a call only its own', async ({
  seed,
}) => {
  const { ada, mara } = await seed('dev').pick({ ada: 'member:ada', mara: 'member:mara' });
  const rpc = endpoint([membershipOf(ada), membershipOf(mara)]);
  const listed = (await rpc('tools/list')).result?.tools?.map((tool) => tool.name) ?? [];
  // Acme is on `team` (→ business), Tinta on `free` (→ team, business).
  expect(listed).toContain('quote_business');
  expect(listed).toContain('quote_team');

  const quote = (name: string, org: Row) =>
    rpc('tools/call', { name, arguments: { org: String(org['orgId']) } });
  expect(textOf(await quote('quote_team', mara))).toContain('"charge"');
  // `quote_team` is not Acme's to call: absent from its catalog, so not found.
  expect((await quote('quote_team', ada)).error?.code).toBe(-32601);
  expect(textOf(await quote('quote_business', ada))).toContain('"charge"');
});
