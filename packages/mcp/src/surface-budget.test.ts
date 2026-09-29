// `measureMcpSurface` / `assertMcpSurfaceBudget`: the characters an agent reads, off the wire, per
// caller — and a refusal naming every surface over its ceiling.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult } from './registry';
import { createMcpServer } from './server';
import { assertMcpSurfaceBudget, measureMcpSurface } from './surface-budget';
import { NO_ARGS } from './wire';

const tool = (name: string): AnyMcpTool => ({
  name,
  description: `The ${name} tool, described at some length so the catalog has weight.`,
  inputSchema: NO_ARGS,
  destructive: false,
  handle: async () => jsonResult({ ok: true }),
});

const staff: McpCaller = {
  actor: agentActor({ id: 's', orgId: 'o', roles: ['staff'] }),
  role: 'staff',
  scopes: new Set<string>(),
};
const customer: McpCaller = { ...staff, role: 'customer' };

const server = () =>
  createMcpServer({
    tools: [tool('a'), tool('b'), tool('docs')],
    surface: (caller) => (caller.role === 'staff' ? 'meta' : 'flat'),
    groups: { things: { description: 'Things', tools: ['a', 'b'] } },
    instructions: (caller) => (caller.role === 'staff' ? 'Staff advice.' : undefined),
  });

describe('assertMcpSurfaceBudget', () => {
  test('names every surface over its ceiling in one refusal', async () => {
    const refused = await assertMcpSurfaceBudget(server(), staff, {
      toolsList: 10,
      listResources: 10,
      instructions: 1_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: 'X_MCP_SURFACE_OVER_BUDGET' });
    const cause = (refused as { cause: string }).cause;
    expect(cause).toInclude('tools/list is ');
    expect(cause).toInclude('list_resources is ');
    expect(cause).not.toInclude('instructions');
  });

  test('within budget answers the measurement', async () => {
    const size = await assertMcpSurfaceBudget(server(), staff, { toolsList: 100_000 });
    expect(size.toolsList).toBeGreaterThan(0);
  });
});

describe('measureMcpSurface', () => {
  test('measures per caller: the meta population reads list_resources, the flat one has none', async () => {
    const meta = await measureMcpSurface(server(), staff);
    const flat = await measureMcpSurface(server(), customer);
    expect(meta.listResources).toBeGreaterThan(0);
    expect(meta.instructions).toBe('Staff advice.'.length);
    expect(flat.listResources).toBeUndefined();
    expect(flat.instructions).toBe(0);
  });

  test('tools/list is measured as serialized — the bytes a client hands its model', async () => {
    const s = server();
    const response = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, customer);
    const size = await measureMcpSurface(s, customer);
    expect(size.toolsList).toBe(JSON.stringify(response?.result).length);
  });
});
