/**
 * contract — an agent's `publishPost` over MCP waits for a person (`./confirmations.ts`): the call
 * opens a pending confirmation and publishes nothing, an owner or admin who is not the requester
 * views it and approves exactly that call with a signature from a key registered to them, and the
 * agent's repeat then runs it — through the action's own policy.
 *
 * The decision action is registered by the test preload's boot of `apps/web/api`, so it has its
 * name and its route here; the MCP server is the real one, `@postly/mcp`'s `mcp`.
 */

import { agentActor } from '@ultimat3/core';
import { afterEach, expect, test } from '@ultimat3/testing';
import { confirmAgentPublish } from './confirmations';
import { APPROVER_KEYS_ENV } from './confirmations-keys';
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

const registryBefore = Bun.env[APPROVER_KEYS_ENV];
afterEach(() => {
  if (registryBefore === undefined) delete Bun.env[APPROVER_KEYS_ENV];
  else Bun.env[APPROVER_KEYS_ENV] = registryBefore;
});

const b64url = (bytes: ArrayBuffer): string =>
  new Uint8Array(bytes).toBase64({ alphabet: 'base64url', omitPadding: true });

/** A device key for `memberId`, its public half registered in the app's approver registry. */
const deviceKeyFor = async (memberId: string) => {
  const key = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = b64url(await crypto.subtle.exportKey('raw', key.publicKey));
  Bun.env[APPROVER_KEYS_ENV] = JSON.stringify({ [memberId]: [publicKey] });
  return async (payload: string): Promise<string> =>
    b64url(await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(payload)));
};

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

  const sign = await deviceKeyFor(ada.id);
  const viewed = await confirmAgentPublish.as(actorFor(ada), { id, decision: 'view' });
  expect(viewed).toMatchObject({ tool: 'publishPost', status: 'pending', arguments: args });
  const approved = await confirmAgentPublish.as(actorFor(ada), {
    id,
    decision: 'approve',
    arguments: viewed.arguments,
    signature: await sign(viewed.signingPayload),
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
  // Its OWN confirmation key — `notify: true` is another argument digest — so the row this test
  // leaves rejected can never be the one the approval test above opens, in either order: the store
  // is module-scoped and keyed by actor, tool and digest.
  const args = { postId: draft.id, orgId: draft.orgId, notify: true };

  const asked = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  const id = UUID.exec(asked)?.[1] ?? expect.unreachable(`no confirmation id in: ${asked}`);
  await confirmAgentPublish.as(actorFor(ada), { id, decision: 'reject' });

  const refused = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  expect(refused).toContain('X_MCP_CONFIRMATION_REJECTED');
});

test('the requester, a non-approver and an unregistered key approve nothing', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno, ada } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
    ada: 'member:ada',
  });
  // Ada's agent asks this time, so Ada is the requester; the args are this test's own digest.
  const args = { postId: draft.id, orgId: draft.orgId, notify: false };
  const asked = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(ada)));
  const id = UUID.exec(asked)?.[1] ?? expect.unreachable(`no confirmation id in: ${asked}`);
  const viewed = await confirmAgentPublish.as(actorFor(ada), { id, decision: 'view' });
  const signAsAda = await deviceKeyFor(ada.id);
  const signature = await signAsAda(viewed.signingPayload);
  const approve = (actor: ReturnType<typeof actorFor>, signed: string) =>
    confirmAgentPublish.as(actor, {
      id,
      decision: 'approve',
      arguments: viewed.arguments,
      signature: signed,
    });

  // Ada's own signature is valid — and still no approval of a request her agent made.
  await expect(approve(actorFor(ada), signature)).rejects.toBeUltimateError('X_FORBIDDEN');
  // Bruno is an author: outside `role:owner` / `role:admin`.
  await expect(approve(actorFor(bruno), signature)).rejects.toBeUltimateError('X_FORBIDDEN');
  const again = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(ada)));
  expect(again).toContain('X_MCP_CONFIRMATION_PENDING');
});

test('an approver signing with a key not registered to them stores no vote', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno, ada } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
    ada: 'member:ada',
  });
  const args = { postId: draft.id, orgId: draft.orgId, notify: false };
  const asked = textOf(await postlyMcp().server.handle(publishCall(args), agentFor(bruno)));
  const id = UUID.exec(asked)?.[1] ?? expect.unreachable(`no confirmation id in: ${asked}`);
  const viewed = await confirmAgentPublish.as(actorFor(ada), { id, decision: 'view' });
  // A key registered to Bruno, used by Ada: well-formed, verifying, and not hers.
  const signAsBruno = await deviceKeyFor(bruno.id);
  await expect(
    confirmAgentPublish.as(actorFor(ada), {
      id,
      decision: 'approve',
      arguments: viewed.arguments,
      signature: await signAsBruno(viewed.signingPayload),
    }),
  ).rejects.toBeUltimateError('X_MCP_CONFIRMATION_EVIDENCE_INVALID');
  expect(
    (await confirmAgentPublish.as(actorFor(ada), { id, decision: 'view' })).approvedBy,
  ).toEqual([]);
});
