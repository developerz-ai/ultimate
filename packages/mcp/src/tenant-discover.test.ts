// `tenant.discover` and `tenant.optional`: a `tenant` server whose tool list stays constant. The
// discover tool answers the tenant list when a call names no tenant, so `list_tenants` is not
// registered; an optional tool runs as the person without the arg and as the tenant actor with it.
// A tenant the person is not in still answers byte for byte what an unknown tool answers.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { defineAppMcp } from './app-tools';
import { resetServedRecipes } from './recipe-links';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult } from './registry';
import type { McpServerInput } from './server';
import { mcpServer } from './server';
import type { McpTenant } from './tenant';
import type { JsonRpcResponse } from './wire';
import { INTERNAL_ERROR, METHOD_NOT_FOUND } from './wire';

afterEach(resetServedRecipes);

const call = (name: string, args?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: args === undefined ? { name } : { name, arguments: args },
});
const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
const textOf = (response: JsonRpcResponse | null): string =>
  ((response?.result as { content?: { text: string }[] } | undefined)?.content ?? [])[0]?.text ??
  '';
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

const MEMBERSHIPS = new Map([
  ['acme', 'owner'],
  ['gamma', 'reader'],
]);
const person: McpCaller = { actor: agentActor({ id: 'p_ada' }), scopes: new Set() };

let resolveCalls = 0;
const tenant = (overrides: Partial<McpTenant> = {}): McpTenant => ({
  arg: 'project',
  resolve: ({ person: who, value }): Actor | null => {
    resolveCalls += 1;
    const role = MEMBERSHIPS.get(value);
    return role === undefined ? null : agentActor({ id: who.id, orgId: value, roles: [role] });
  },
  list: () => [...MEMBERSHIPS.keys()].map((value) => ({ value, name: value.toUpperCase() })),
  ...overrides,
});

/** Answers the org it ran in and the tenant on its caller: `null` twice when it ran as the person. */
const whereAmI = (name: string, extra: Partial<AnyMcpTool> = {}): AnyMcpTool => ({
  name,
  description: 'Where this call ran. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  destructive: false,
  handle: async (args, caller) =>
    jsonResult({ org: caller.actor.orgId ?? null, tenant: caller.tenant ?? null, args }),
  ...extra,
});

const GROUPS = { crm: { description: 'The CRM', tools: ['push'] } };
const split = (overrides: Partial<McpTenant> = {}, extra: Partial<McpServerInput> = {}) => {
  resolveCalls = 0;
  return mcpServer({
    tenant: tenant({ discover: 'list_resources', optional: ['about'], ...overrides }),
    surface: 'meta-split',
    groups: GROUPS,
    tools: [whereAmI('push', { destructive: true, effect: 'write' }), whereAmI('about')],
    ...extra,
  });
};

interface ListedTool {
  readonly name: string;
  readonly inputSchema: { required?: string[]; properties?: Record<string, unknown> };
}
const listed = async (mcp: ReturnType<typeof mcpServer>): Promise<readonly ListedTool[]> => {
  const result = (await mcp.handle(list, person))?.result as { tools: ListedTool[] } | undefined;
  return result?.tools ?? [];
};

describe('tenant.discover', () => {
  test('the discover tool answers the tenant list when the call names no tenant', async () => {
    const mcp = split();
    for (const args of [undefined, {}]) {
      const text = textOf(await inRequest(() => mcp.handle(call('list_resources', args), person)));
      expect(JSON.parse(text)).toEqual({
        tenants: [
          { value: 'acme', name: 'ACME' },
          { value: 'gamma', name: 'GAMMA' },
        ],
        next: 'list_resources({ "project": "<one of the values>" })',
      });
    }
    // Membership is never asked: the list is the person's own.
    expect(resolveCalls).toBe(0);
  });

  test('with a tenant it is the tool it always was, run as the tenant actor', async () => {
    const mcp = split();
    const text = textOf(
      await inRequest(() => mcp.handle(call('list_resources', { project: 'acme' }), person)),
    );
    expect(text).toContain('crm');
    expect(text).not.toContain('"tenants"');
    expect(resolveCalls).toBe(1);
  });

  test('list_tenants is not registered: unlisted, and unknown when called', async () => {
    const mcp = split();
    expect((await listed(mcp)).map((tool) => tool.name)).toEqual([
      'about',
      'delete_resource',
      'describe_resource',
      'list_resources',
      'read_resource',
      'write_resource',
    ]);
    const unknown = await mcp.handle(call('nope', { project: 'acme' }), person);
    const answer = await mcp.handle(call('list_tenants', { project: 'acme' }), person);
    expect(answer?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(answer).replace('list_tenants', 'nope')).toBe(JSON.stringify(unknown));
    // With no tenant it is refused as any other name is, before the name is looked at.
    expect(textOf(await mcp.handle(call('list_tenants', {}), person))).toContain(
      'X_MCP_TENANT_REQUIRED',
    );
  });

  test('a call naming no tenant is X_MCP_TENANT_REQUIRED, pointing at the discover tool', async () => {
    const mcp = split();
    for (const [name, args] of [
      ['read_resource', { resource: 'crm', action: 'push' }],
      ['describe_resource', { resources: ['crm'] }],
      ['nope', {}],
      // Present and unusable is never read as absent: neither door opens on a malformed value.
      ['list_resources', { project: '' }],
      ['list_resources', { project: null }],
      ['about', { project: 7 }],
    ] as const) {
      const text = textOf(await inRequest(() => mcp.handle(call(name, args), person)));
      expect(text).toContain('X_MCP_TENANT_REQUIRED');
      expect(text).toContain('list_resources({})');
      expect(text).not.toContain('list_tenants');
    }
    expect(resolveCalls).toBe(0);
  });

  test('unknown tool and non-member stay byte identical, on the discover and the optional tool', async () => {
    const mcp = split();
    const unknown = await mcp.handle(call('nope', { project: 'acme' }), person);
    expect(unknown?.error?.code).toBe(METHOD_NOT_FOUND);
    for (const name of ['list_resources', 'about', 'read_resource']) {
      const foreign = await mcp.handle(call(name, { project: 'evil' }), person);
      expect(JSON.stringify(foreign).replace(name, 'nope')).toBe(JSON.stringify(unknown));
      expect(JSON.stringify(foreign)).not.toContain('evil');
    }
    // And an unknown name in a foreign tenant is the same answer again.
    const both = await mcp.handle(call('nope', { project: 'evil' }), person);
    expect(JSON.stringify(both)).toBe(JSON.stringify(unknown));
  });

  test('a flat server may name one of its own tools', async () => {
    resolveCalls = 0;
    const mcp = mcpServer({
      tenant: tenant({ discover: 'about' }),
      tools: [whereAmI('about'), whereAmI('other')],
    });
    expect((await listed(mcp)).map((tool) => tool.name)).toEqual(['about', 'other']);
    const none = textOf(await inRequest(() => mcp.handle(call('about', {}), person)));
    expect(JSON.parse(none).tenants).toHaveLength(2);
    const inAcme = textOf(
      await inRequest(() => mcp.handle(call('about', { project: 'acme' }), person)),
    );
    expect(JSON.parse(inAcme)).toEqual({ org: 'acme', tenant: 'acme', args: {} });
  });

  test('the discover tool keeps its own scope on the call that names no tenant', async () => {
    const mcp = mcpServer({
      tenant: tenant({ discover: 'about' }),
      tools: [whereAmI('about', { scope: 'org:read' })],
    });
    const denied = await inRequest(() => mcp.handle(call('about', {}), person));
    expect(JSON.stringify(denied)).toContain('X_MCP_SCOPE_DENIED');
    expect(JSON.stringify(denied)).not.toContain('acme');
    const scoped: McpCaller = { ...person, scopes: new Set(['org:read']) };
    const text = textOf(await inRequest(() => mcp.handle(call('about', {}), scoped)));
    expect(JSON.parse(text).tenants).toHaveLength(2);
  });

  test('a list that throws is a failed call, never an empty list', async () => {
    const mcp = split({ list: () => Promise.reject(new Error('pool exhausted at db.internal')) });
    const answer = await inRequest(() => mcp.handle(call('list_resources', {}), person));
    expect(answer?.error?.code).toBe(INTERNAL_ERROR);
    expect(answer?.result).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain('db.internal');
  });
});

describe('tenant.optional', () => {
  test('runs as the person with no tenant, and as the tenant actor with one', async () => {
    const mcp = split();
    const alone = textOf(await inRequest(() => mcp.handle(call('about', {}), person)));
    expect(JSON.parse(alone)).toEqual({ org: null, tenant: null, args: {} });
    expect(resolveCalls).toBe(0);
    const inGamma = textOf(
      await inRequest(() => mcp.handle(call('about', { project: 'gamma' }), person)),
    );
    // Stripped before validation, exactly as on every other tool.
    expect(JSON.parse(inGamma)).toEqual({ org: 'gamma', tenant: 'gamma', args: {} });
  });

  test('works beside list_tenants, with no discover tool', async () => {
    resolveCalls = 0;
    const mcp = mcpServer({
      tenant: tenant({ optional: ['about'] }),
      tools: [whereAmI('about'), whereAmI('other')],
    });
    expect((await listed(mcp)).map((tool) => tool.name)).toEqual([
      'about',
      'list_tenants',
      'other',
    ]);
    const alone = textOf(await inRequest(() => mcp.handle(call('about', {}), person)));
    expect(JSON.parse(alone).org).toBeNull();
    const refused = textOf(await inRequest(() => mcp.handle(call('other', {}), person)));
    expect(refused).toContain('list_tenants({})');
  });

  test('docs({}) runs with no tenant and with one', async () => {
    const { server } = defineAppMcp({
      tenant: tenant({ optional: ['docs'] }),
      tools: [whereAmI('about')],
      recipes: [
        {
          name: 'find-yourself',
          title: 'Find yourself',
          description: 'Ask where the call ran.',
          steps: [{ tool: 'about', why: 'it says where' }],
        },
      ],
    });
    const alone = textOf(await inRequest(() => server.handle(call('docs', {}), person)));
    expect(alone).toContain('find-yourself');
    const inAcme = textOf(
      await inRequest(() => server.handle(call('docs', { project: 'acme' }), person)),
    );
    expect(inAcme).toBe(alone);
    const foreign = await server.handle(call('docs', { project: 'evil' }), person);
    expect(foreign?.error?.code).toBe(METHOD_NOT_FOUND);
  });
});

describe('tools/list publishes the tenant arg as required only where it is', () => {
  test('optional on the discover and the optional tools, required on the rest', async () => {
    const tools = await listed(split());
    const requires = (name: string) =>
      (tools.find((tool) => tool.name === name)?.inputSchema.required ?? []).includes('project');
    for (const tool of tools) {
      expect(Object.hasOwn(tool.inputSchema.properties ?? {}, 'project')).toBe(true);
      expect(requires(tool.name)).toBe(tool.name !== 'list_resources' && tool.name !== 'about');
    }
    const described = (name: string) =>
      JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema.properties?.['project']);
    expect(described('list_resources')).toContain('Omit it to list the tenants');
    expect(described('about')).toContain('Optional');
    expect(described('read_resource')).toContain('list_resources');
    expect(JSON.stringify(tools)).not.toContain('list_tenants');
  });
});

describe('boot refuses a discover or optional tool no call could reach', () => {
  const boot = (overrides: Partial<McpTenant>, extra: Partial<McpServerInput> = {}) => {
    try {
      split(overrides, extra);
    } catch (error) {
      const refusal = error as { code?: string; cause?: string };
      return `${refusal.code}: ${refusal.cause}`;
    }
    return 'booted';
  };

  test('a discover tool that does not exist', () => {
    expect(boot({ discover: 'nope' })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({ discover: 'nope' })).toContain('"nope"');
    expect(boot({ discover: '' })).toContain('X_MCP_TENANT_INVALID');
  });

  test('a discover tool that is grouped', () => {
    expect(boot({ discover: 'push' })).toMatch(/X_MCP_TENANT_INVALID.*group/);
  });

  test('a meta tool other than list_resources, or one not every caller is served', () => {
    expect(boot({ discover: 'read_resource' })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({}, { surface: () => 'meta-split' })).toContain('X_MCP_TENANT_INVALID');
    expect(
      (() => {
        try {
          mcpServer({ tenant: tenant({ discover: 'list_resources' }), tools: [whereAmI('a')] });
        } catch (error) {
          return (error as { code?: string }).code;
        }
        return 'booted';
      })(),
    ).toBe('X_MCP_TENANT_INVALID');
  });

  test('a discover tool some caller could not see', () => {
    const hidden = { tools: [whereAmI('push', { effect: 'write', destructive: true })] };
    expect(
      boot(
        { discover: 'about', optional: [] },
        { tools: [...hidden.tools, whereAmI('about', { visibleTo: ['owner'] })] },
      ),
    ).toMatch(/X_MCP_TENANT_INVALID.*visibleTo/);
  });

  test('an optional tool that does not exist, is grouped, is named twice or is the discover tool', () => {
    expect(boot({ optional: ['nope'] })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({ optional: ['push'] })).toMatch(/X_MCP_TENANT_INVALID.*group/);
    expect(boot({ optional: ['about', 'about'] })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({ optional: ['list_resources'] })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({ optional: 'about' as unknown as string[] })).toContain('X_MCP_TENANT_INVALID');
    expect(boot({})).toBe('booted');
  });
});
