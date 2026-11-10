// `defineAppMcp({ tenant })`: one token, the tenant named per call. The person drives org A then
// org B over one caller; a foreign tenant answers as a hidden tool; a lookup that throws never does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { agentActor, ctxOf, installLogSink, runWithContext, userActor } from '@ultimat3/core';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { McpTenantRequiredError } from './catalog-errors';
import type { McpCaller } from './registry';
import { ToolRegistry, textResult } from './registry';
import type { McpTenant } from './tenant';
import type { JsonRpcResponse } from './wire';
import { METHOD_NOT_FOUND } from './wire';

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

/** One person, three orgs; the token resolves to the person, with no org of their own. */
const MEMBERSHIPS = new Map([
  ['acme', 'owner'],
  ['beta', 'owner'],
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

let seen: { input: unknown; orgId: unknown }[] = [];
const server = (overrides: Partial<McpTenant> = {}) =>
  defineAppMcp({
    tenant: tenant(overrides),
    tools: {
      orgName: {
        description: 'The acting org. Read-only.',
        input: t.object({ shout: t.optional(t.boolean) }),
        policy: 'org:read',
        destructive: false,
        handle: ({ input, ctx }) => {
          seen.push({ input, orgId: ctx.actor.orgId });
          return { org: ctx.actor.orgId };
        },
      },
      orgAdmin: {
        description: 'Owners only.',
        input: t.object({}),
        policy: 'org:read',
        visibleTo: ['owner'],
        handle: () => ({ ok: true }),
      },
    },
  }).server;

beforeEach(() => {
  seen = [];
  resolveCalls = 0;
  definePermissions(['org:read', 'org:write']);
  defineRoles({ owner: { grants: ['org:read', 'org:write'] }, reader: { grants: ['org:read'] } });
});
afterEach(() => {
  clearPermissions();
  clearRoles();
});

describe('one token across tenants', () => {
  test('org A then org B over one caller: each call acts in its own org', async () => {
    const mcp = server();
    const a = await inRequest(() => mcp.handle(call('orgName', { project: 'acme' }), person));
    const b = await inRequest(() => mcp.handle(call('orgName', { project: 'beta' }), person));
    expect(textOf(a)).toBe('{"org":"acme"}');
    expect(textOf(b)).toBe('{"org":"beta"}');
    // Stripped before validation: the tool's own input never carries it.
    expect(seen).toEqual([
      { input: {}, orgId: 'acme' },
      { input: {}, orgId: 'beta' },
    ]);
    // Nothing cached on the caller the transport handed in.
    expect(person.actor.orgId).toBeUndefined();
    expect(resolveCalls).toBe(2);
  });

  test('a call naming no tenant is X_MCP_TENANT_REQUIRED, pointing at list_tenants', async () => {
    const mcp = server();
    for (const args of [undefined, {}, { project: '' }, { project: 7 }]) {
      const text = textOf(await inRequest(() => mcp.handle(call('orgName', args), person)));
      expect(text).toContain('X_MCP_TENANT_REQUIRED');
      expect(text).toContain('list_tenants({})');
    }
    expect(resolveCalls).toBe(0);
  });

  test('row 857 of the wiki page carries that fix verbatim', async () => {
    // The page is the copy an agent reads before it has the code, so it says what the error says.
    // `new-error-code` writes a row from the registered fix; this is the same identity, held the
    // other way round, so hand-editing one of the two is what turns it red.
    const page = await Bun.file(`${import.meta.dir}/../../../wiki/Error-Codes.md`).text();
    const row = page.split('\n').find((line) => line.startsWith('| `X_MCP_TENANT_REQUIRED` |'));
    const cells = (row ?? '').split('|').map((cell) => cell.trim());
    // The Fix cell is the last one; `fixCell` wraps an unformatted fix in backticks.
    const cell = (cells.at(-2) ?? '').replace(/^`|`$/g, '');
    expect(cell).toBe(new McpTenantRequiredError({ arg: 'tenant' }).fix);
    expect(cell).toContain('list_tenants({})');
  });

  test('list_tenants answers the person’s tenants, with no tenant named', async () => {
    const text = textOf(await inRequest(() => server().handle(call('list_tenants'), person)));
    expect(JSON.parse(text)).toEqual({
      tenants: [
        { value: 'acme', name: 'ACME' },
        { value: 'beta', name: 'BETA' },
        { value: 'gamma', name: 'GAMMA' },
      ],
    });
  });

  test('a foreign tenant answers byte for byte what a hidden tool answers', async () => {
    const mcp = server();
    const foreign = await mcp.handle(call('orgName', { project: 'evil' }), person);
    const huge = await mcp.handle(call('orgName', { project: 'x'.repeat(300) }), person);
    // `orgAdmin` is visible to the `owner` MCP role only, and this token carries none: hidden.
    const hidden = await mcp.handle(call('orgAdmin', { project: 'gamma' }), person);
    expect(foreign?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(huge));
    expect(JSON.stringify(foreign).replace('orgName', 'orgAdmin')).toBe(JSON.stringify(hidden));
    expect(JSON.stringify(foreign)).not.toContain('evil');
    expect(seen).toEqual([]);
  });

  test('a lookup that throws is X_MCP_TENANT_UNRESOLVED, never "not a member"', async () => {
    const mcp = server({
      resolve: () => Promise.reject(new Error('pool exhausted at db.internal')),
    });
    const answer = await inRequest(() => mcp.handle(call('orgName', { project: 'acme' }), person));
    expect(answer?.error).toBeUndefined();
    expect(textOf(answer)).toContain('X_MCP_TENANT_UNRESOLVED');
    expect(textOf(answer)).not.toContain('db.internal');
  });

  test('an actor that is not an agent is refused, never run', async () => {
    const mcp = server({ resolve: () => userActor({ id: 'p_ada', orgId: 'acme' }) });
    const answer = await inRequest(() => mcp.handle(call('orgName', { project: 'acme' }), person));
    expect(textOf(answer)).toContain('X_MCP_TENANT_UNRESOLVED');
    expect(seen).toEqual([]);
  });

  test('tools/list publishes the tenant arg as required on every tool but list_tenants', async () => {
    const listed = (await server().handle(list, person))?.result as {
      tools: { name: string; inputSchema: { required?: string[]; properties?: object } }[];
    };
    for (const tool of listed.tools) {
      const required = tool.inputSchema.required ?? [];
      expect(required.includes('project')).toBe(tool.name !== 'list_tenants');
    }
  });

  test('tools/list is person-scoped: a tenant-role tool is unlisted, and the call decides', async () => {
    // MCP's tools/list names no tenant, so `visibleTo` there reads the PERSON — who holds no role.
    const mcp = defineAppMcp({
      tenant: tenant(),
      tools: [
        {
          name: 'ownerTool',
          description: 'Owners of the acting org only.',
          inputSchema: { type: 'object' },
          visibleTo: (who: McpCaller) => who.actor.roles.includes('owner'),
          handle: async () => textResult('{"ok":true}'),
        },
      ],
    }).server;
    const listed = (await mcp.handle(list, person))?.result as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toEqual(['list_tenants']);
    const owner = await inRequest(() => mcp.handle(call('ownerTool', { project: 'acme' }), person));
    expect(textOf(owner)).toBe('{"ok":true}');
    const reader = await inRequest(() =>
      mcp.handle(call('ownerTool', { project: 'gamma' }), person),
    );
    expect(reader?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('the audit line carries the tenant the call acted in', async () => {
    const lines: Record<string, unknown>[] = [];
    const releaseLogSink = installLogSink((line) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
    );
    try {
      await inRequest(() => server().handle(call('orgName', { project: 'beta' }), person));
    } finally {
      releaseLogSink();
    }
    expect(lines.find((line) => line['msg'] === 'mcp.tool-call.ok')).toMatchObject({
      tenant: 'beta',
      actor: 'p_ada',
    });
  });

  test('resolve strips the tenant ARG NAME for a DIRECT caller, and only that name', () => {
    // The server strips before dispatch, so this pins the SECOND half of the one mechanism: a
    // direct `resolve` (the meta surface, an embedder, a test) cannot smuggle the reserved arg
    // into input validation. The caller carries the tenant it CHOSE — `'acme'` — never the name
    // it was sent under, which `tenantStep` sets from `args[tenant.arg]`. A fixture using the
    // name as the value (`tenant: 'project'`) proves nothing: it strips a key no call carries.
    const registry = new ToolRegistry('project').register({
      name: 'orgName',
      description: 'the acting org',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async () => textResult('{}'),
    });
    const inAcme: McpCaller = { ...person, tenant: 'acme' };
    const resolved = registry.resolve('orgName', { project: 'acme' }, inAcme);
    expect(resolved.kind).toBe('ok');
    expect(resolved.kind === 'ok' ? resolved.args : undefined).toEqual({});
    // Keying the strip on the VALUE deletes a legitimate argument named after the renter: this
    // tool declares `acme`, and the call both names its tenant and sends that argument.
    const declared = new ToolRegistry('project').register({
      name: 'renter',
      description: 'an argument named after a tenant',
      inputSchema: {
        type: 'object',
        properties: { acme: { type: 'string' } },
        additionalProperties: false,
      },
      handle: async () => textResult('{}'),
    });
    const kept = declared.resolve('renter', { project: 'acme', acme: 'kept' }, inAcme);
    expect(kept.kind === 'ok' ? kept.args : undefined).toEqual({ acme: 'kept' });
    // A registry told no tenant arg strips nothing: the arg survives and validation refuses it,
    // which is the state `mcpServer` builds today — the EMPTY registry would answer `not-found`.
    const bare = new ToolRegistry();
    bare.register({
      name: 'orgName',
      description: 'the acting org',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: async () => textResult('{}'),
    });
    expect(bare.resolve('orgName', { project: 'acme' }, inAcme).kind).toBe('invalid-args');
  });

  test('boot refuses an arg a tool already declares, or one that is not a name', () => {
    const declares = () =>
      defineAppMcp({
        tenant: tenant(),
        tools: {
          clash: {
            description: 'x',
            input: t.object({ project: t.string }),
            policy: 'org:read',
            handle: () => null,
          },
        },
      });
    expect(declares).toThrow(/X_MCP_TENANT_INVALID/);
    expect(() => defineAppMcp({ tenant: tenant({ arg: 'a b' }) })).toThrow(/X_MCP_TENANT_INVALID/);
  });
});
