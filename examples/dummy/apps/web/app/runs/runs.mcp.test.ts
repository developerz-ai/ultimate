/**
 * contract — the run console as an agent sees it. Nothing here is written by hand: each tool is
 * an action or a query that declared `mcp: { expose: true }`, projected with its own policy. Drop
 * one `expose` and this file is what notices.
 */

import { mcp } from '@postly/mcp';
import { agentActor } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';

const ORG = '00000000-0000-4000-8000-0000000000a1';

/** An agent acting for a member: the same id, org and role a signed-in author carries. */
const agent = (orgId: string, role = 'author') => ({
  actor: agentActor({ id: 'agent-1', orgId, roles: [role] }),
  scopes: new Set<string>(),
});

const toolCall = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

interface ToolCallResponse {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
}

test('the tool list names the three run actions and the live query, verbatim', () => {
  const names = mcp.server.list(agent(ORG)).map((tool) => tool.name);
  expect(names).toContain('startRun');
  expect(names).toContain('answerPrompt');
  expect(names).toContain('cancelRun');
  expect(names).toContain('liveRunEvents');
});

test('the two commands that carry a secret are not tools', () => {
  const names = mcp.server.list(agent(ORG)).map((tool) => tool.name);
  expect(names).not.toContain('connectSite');
  expect(names).not.toContain('issueRunKey');
});

test('an agent outside the org is denied startRun over MCP, by the action’s own policy', async () => {
  const args = { orgId: ORG, connectionId: '00000000-0000-4000-8000-0000000000d1' };
  const elsewhere = agent('00000000-0000-4000-8000-0000000000a9');
  const response = (await mcp.server.handle(
    toolCall('startRun', args),
    elsewhere,
  )) as ToolCallResponse;
  expect(response.result?.isError).toBe(true);
  expect(response.result?.content?.[0]?.text ?? '').toContain('X_FORBIDDEN');
});
