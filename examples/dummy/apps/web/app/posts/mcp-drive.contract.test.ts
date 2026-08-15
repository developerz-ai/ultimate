/**
 * contract — an agent driving Postly's posts feature through the wire MCP protocol only:
 * JSON-RPC requests dispatched through `mcp.server.handle()`, the transport-independent entry
 * point both the HTTP route (`mcpHttpRoute`) and stdio (`serveStdio`) call. No action is
 * invoked directly here — `mcp.server.handle(body, caller)` reaches `action.run`, the SAME
 * entry point an HTTP request reaches (`packages/mcp/src/exposed.ts`), so a denial observed
 * here over the wire IS "the same authz as the UI" (docs/idea/14-roadmap.md, M9's done-when),
 * not merely the policy-object identity `actions.contract.test.ts` already pins for the direct
 * call.
 *
 * What this file proves is the DENIAL path, and that is a choice rather than a gap: `createPost`
 * and `createComment` both decide on `actor` + `input` alone, before their handler ever runs, so
 * a denial observed here is the authz decision itself and not a write that happened to fail after
 * it. The allowed path writes rows, which is `actions.contract.test.ts`'s and the live suite's
 * job — `repo.ts` runs on @ultimat3/entity's real surface now (`preload`, `upsertAll`,
 * `deleteWhere`), so the handlers reach the driver instead of throwing at the builder.
 * `publishPost` loads its row before the guard (`ctx.posts.authorship`, scoped to the org the
 * input names — see `policy.ts`) and is exercised there, not here.
 */

import { mcp } from '@postly/mcp';
import { agentActor } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { createComment, createPost } from './actions';

interface Member {
  readonly id: string;
  readonly [column: string]: unknown;
}

/**
 * An MCP agent acting on behalf of a signed-in member — same id, org and roles the direct-call
 * actor below carries, `kind: 'agent'` instead of `'user'`. `memberOf()` in `@postly/core`
 * reads those three fields structurally, so this is authz-equivalent to `actorFor()` in
 * `scripts/test-setup.ts`; it differs only in the one axis a real policy is allowed to see —
 * this call came from an agent, not a browser session. Mirrors `apps/admin/src/mcp.ts`'s
 * `resolveToken`, which is what a real bearer-token resolution for `mcp.route` will build once
 * Postly issues agent tokens (tracked separately — `mcp.ts` has no `resolveToken` yet).
 *
 * Structurally typed against `McpCaller` (`@ultimat3/mcp`) rather than importing it: `@postly/mcp`
 * — the one package this app boundary allows a test outside `packages/mcp` to reach — does not
 * re-export the framework's wire types, and this file has no other reason to depend on
 * `@ultimat3/mcp` directly.
 */
const agentFor = (member: Member) => ({
  actor: agentActor({
    id: String(member['userId'] ?? member.id),
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  }),
  scopes: new Set<string>(),
});

let nextId = 0;
const toolCall = (name: string, args: Record<string, unknown>) => {
  nextId += 1;
  return {
    jsonrpc: '2.0' as const,
    id: nextId,
    method: 'tools/call',
    params: { name, arguments: args },
  };
};

interface ToolCallResponse {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
}

const isError = (response: unknown): boolean =>
  (response as ToolCallResponse).result?.isError === true;
const textOf = (response: unknown): string =>
  (response as ToolCallResponse).result?.content?.[0]?.text ?? '';

test('tools/list exposes createPost and createComment to an agent caller', () => {
  const caller = agentFor({ id: 'probe', orgId: 'org', role: 'author' });
  const names = mcp.server.list(caller).map((tool) => tool.name);

  expect(names).toContain('createPost');
  expect(names).toContain('createComment');
});

test('an agent outside the org is denied createPost over MCP, identically to the direct call', async ({
  seed,
  actorFor,
}) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' });
  const args = {
    orgId: '00000000-0000-4000-8000-000000000099',
    title: 'A title long enough to be valid',
    body: 'x'.repeat(80),
  };

  // The reference decision: what "the UI" gets from a direct call.
  await expect(createPost.as(actorFor(author), args)).rejects.toBeUltimateError('X_FORBIDDEN');

  // The same decision, reached entirely over the wire protocol.
  const response = await mcp.server.handle(toolCall('createPost', args), agentFor(author));

  expect(isError(response)).toBe(true);
  expect(textOf(response)).toContain('X_FORBIDDEN');
});

test('an agent outside the org is denied createComment over MCP, identically to the direct call', async ({
  seed,
  actorFor,
}) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' });
  const args = {
    orgId: '00000000-0000-4000-8000-000000000099',
    postId: '00000000-0000-4000-8000-000000000001',
    body: 'x'.repeat(30),
  };

  await expect(createComment.as(actorFor(author), args)).rejects.toBeUltimateError('X_FORBIDDEN');

  const response = await mcp.server.handle(toolCall('createComment', args), agentFor(author));

  expect(isError(response)).toBe(true);
  expect(textOf(response)).toContain('X_FORBIDDEN');
});

test('an unknown tool name is ToolNotFound over MCP, never a stack trace', async () => {
  const caller = agentFor({ id: 'probe', orgId: 'org', role: 'author' });

  const response = (await mcp.server.handle(toolCall('deletePost', {}), caller)) as {
    readonly error?: { readonly code?: number };
  };

  expect(response.error?.code).toBe(-32601);
});
