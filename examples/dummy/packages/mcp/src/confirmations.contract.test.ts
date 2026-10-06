/**
 * contract — an agent's `publishPost` over MCP waits for a person (`./confirmations.ts`): the call
 * opens a pending confirmation and publishes nothing, a member who holds `post:publish` views and
 * approves exactly that call, and the agent's repeat then runs it — through the action's own policy.
 *
 * The decision action is registered by the test preload's boot of `apps/web/api`, so it has its
 * name and its route here; the MCP server is the real one, `@postly/mcp`'s `mcp`.
 */

import { agentActor } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { confirmAgentPublish } from './confirmations';
import { postlyMcp } from './tools';

interface Member {
  readonly id: string;
  readonly [column: string]: unknown;
}

/**
 * An agent acting for a member, keyed by the MEMBER id — Postly's actor identity (`actorFor`), so
 * `postPublish`'s authorship half sees the draft's author when the approved call runs.
 */
const agentFor = (member: Member) => ({
  actor: agentActor({
    id: member.id,
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  }),
  scopes: new Set<string>(),
});

let nextId = 0;
const publishCall = (args: Record<string, unknown>) => {
  nextId += 1;
  return {
    jsonrpc: '2.0' as const,
    id: nextId,
    method: 'tools/call',
    params: { name: 'publishPost', arguments: args },
  };
};

interface ToolCallResponse {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
}
const textOf = (response: unknown): string =>
  (response as ToolCallResponse).result?.content?.[0]?.text ?? '';

const UUID = /confirmation ([0-9a-f-]{36}) is pending/;

test('publishPost is gated: an agent asks, a person approves, the repeat publishes', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno, ada } = await seed('dev').pick({
    draft: 'post:draft-money', // Bruno's
    bruno: 'member:bruno',
    ada: 'member:ada',
  });
  const args = { postId: draft.id, orgId: draft.orgId, notify: false };

  const asked = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  expect(asked).toContain('X_MCP_CONFIRMATION_PENDING');
  const id = UUID.exec(asked)?.[1] ?? expect.unreachable(`no confirmation id in: ${asked}`);

  // The agent's own principal cannot decide it, whatever it holds.
  await expect(
    confirmAgentPublish.as(agentFor(bruno).actor, { id, decision: 'approve', arguments: args }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');

  const viewed = await confirmAgentPublish.as(actorFor(ada), { id, decision: 'view' });
  expect(viewed).toMatchObject({ tool: 'publishPost', status: 'pending', arguments: args });
  const approved = await confirmAgentPublish.as(actorFor(ada), {
    id,
    decision: 'approve',
    arguments: viewed.arguments,
  });
  expect(approved.status).toBe('approved');

  const ran = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  expect(ran).toContain('"status":"published"');
});

test('a rejected publish never runs, and the agent is told so', async ({ seed, actorFor }) => {
  const { draft, bruno, ada } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
    ada: 'member:ada',
  });
  const args = { postId: draft.id, orgId: draft.orgId, notify: false };

  const asked = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  const id = UUID.exec(asked)?.[1] ?? expect.unreachable(`no confirmation id in: ${asked}`);
  await confirmAgentPublish.as(actorFor(ada), { id, decision: 'reject' });

  const refused = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  expect(refused).toContain('X_MCP_CONFIRMATION_REJECTED');
});
