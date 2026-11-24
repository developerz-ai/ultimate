// The stricter door of a `'meta-split'` surface, and the app's own envelope fields. A write may
// always come through `delete_resource`, where preview and `confirmed_by_user` apply as for a
// delete; a read only when the app's `stricter` hook demands it for that call. The hook can send a
// call away from its own dispatcher too. `write_resource` is never widened.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, installLogSink, runWithContext } from '@ultimat3/core';
import { clearPermissions, definePermissions } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpAuditEvent } from './audit-hook';
import type { McpSplitCall, McpSplitOptions } from './meta-split-options';
import type { AnyMcpTool, McpCaller, McpDoor } from './registry';
import { jsonResult } from './registry';
import { runtimeTool } from './runtime-tool';
import type { McpServerInput } from './server';
import { mcpServer } from './server';
import type { JsonRpcResponse } from './wire';

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
const text = (response: JsonRpcResponse | null): string =>
  (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text ?? '';
const isError = (response: JsonRpcResponse | null): boolean =>
  (response?.result as { isError?: boolean } | undefined)?.isError === true;
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

const agent: McpCaller = {
  actor: agentActor({ id: 'a1', orgId: 'o1', permissions: ['crm:use'] }),
  scopes: new Set(),
};

interface Ran {
  readonly tool: string;
  readonly args: unknown;
  readonly door: McpDoor | undefined;
}
let ran: Ran[] = [];
let asked: McpSplitCall[] = [];
let audits: McpAuditEvent[] = [];

const tool = (name: string, extra: Partial<AnyMcpTool>): AnyMcpTool => ({
  name,
  description: name,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, amount: { type: 'number' } },
    additionalProperties: false,
  },
  handle: async (args, caller) => {
    ran.push({ tool: name, args, door: caller.door });
    return jsonResult({ ok: name });
  },
  ...extra,
});

const TOOLS = [
  tool('find', { destructive: false }),
  tool('update', { effect: 'write' }),
  tool('remove', { effect: 'delete' }),
];
const GROUPS = { crm: { description: 'The CRM', tools: ['find', 'update', 'remove'] } };

/** Demands the stricter door for a large amount, and for the read of one sensitive id. */
const stricter = (asking: McpSplitCall): boolean => {
  asked.push(asking);
  return Number(asking.params['amount'] ?? 0) > 100 || asking.params['id'] === 'secret';
};

const server = (split?: McpSplitOptions, extra: Partial<McpServerInput> = {}) =>
  mcpServer({
    surface: 'meta-split',
    groups: GROUPS,
    tools: TOOLS,
    onAudit: (event) => {
      audits.push(event);
    },
    ...(split === undefined ? {} : { split }),
    ...extra,
  });

const via = (mcp: ReturnType<typeof mcpServer>, door: string, args: Record<string, unknown>) =>
  inRequest(() => mcp.handle(call(door, { resource: 'crm', ...args }), agent));

beforeEach(() => {
  ran = [];
  asked = [];
  audits = [];
});

describe('a write through delete_resource', () => {
  test('previews unless live, and a live call with no confirmation is refused with retry_with', async () => {
    const mcp = server();
    const preview = await via(mcp, 'delete_resource', { action: 'update', params: { id: 'c1' } });
    expect(JSON.parse(text(preview))).toMatchObject({
      preview: true,
      ran: false,
      action: 'update',
    });
    const live = await via(mcp, 'delete_resource', {
      action: 'update',
      params: { id: 'c1' },
      live: true,
    });
    expect(text(live)).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
    expect(text(live)).toContain('confirmed_by_user: true');
    expect(ran).toEqual([]);
    expect(audits.map((event) => event.kind === 'tool-call' && event.outcome)).toEqual([
      'previewed',
      'unconfirmed',
    ]);
  });

  test('runs once confirmed, never handed the dispatcher flags, and says which door', async () => {
    const mcp = server();
    const answer = await via(mcp, 'delete_resource', {
      action: 'update',
      params: { id: 'c1' },
      live: true,
      confirmed_by_user: true,
    });
    expect(text(answer)).toBe('{"ok":"update"}');
    expect(ran).toEqual([
      { tool: 'update', args: { id: 'c1' }, door: { tool: 'delete_resource', fields: {} } },
    ]);
  });

  test('write_resource is not widened: a delete through it stays refused', async () => {
    const mcp = server({ stricter: () => false });
    for (const split of [mcp, server()]) {
      const answer = await via(split, 'write_resource', { action: 'remove', params: { id: 'c1' } });
      expect(text(answer)).toStartWith('X_MCP_WRONG_TOOL: ');
      expect(text(answer)).toContain('it is run by delete_resource');
    }
    const read = await via(mcp, 'write_resource', { action: 'find', params: {} });
    expect(text(read)).toContain('it is run by read_resource');
    const viaRead = await via(mcp, 'read_resource', { action: 'update', params: { id: 'c1' } });
    expect(text(viaRead)).toContain('it is run by write_resource');
    expect(ran).toEqual([]);
  });
});

describe('a read through delete_resource', () => {
  test('nobody gated it: still X_MCP_WRONG_TOOL, with a hook and without', async () => {
    for (const mcp of [server(), server({ stricter })]) {
      const answer = await via(mcp, 'delete_resource', {
        action: 'find',
        params: { id: 'c1' },
        live: true,
        confirmed_by_user: true,
      });
      expect(text(answer)).toStartWith('X_MCP_WRONG_TOOL: ');
      expect(text(answer)).toContain('it is run by read_resource');
    }
    expect(ran).toEqual([]);
  });

  test('the app gated it: it previews, refuses an unconfirmed commit, and runs confirmed', async () => {
    const mcp = server({ stricter });
    const params = { id: 'secret' };
    const preview = await via(mcp, 'delete_resource', { action: 'find', params });
    expect(JSON.parse(text(preview))).toMatchObject({ preview: true, ran: false });
    const unconfirmed = await via(mcp, 'delete_resource', { action: 'find', params, live: true });
    expect(text(unconfirmed)).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
    expect(ran).toEqual([]);
    const live = await via(mcp, 'delete_resource', {
      action: 'find',
      params,
      live: true,
      confirmed_by_user: true,
    });
    expect(text(live)).toBe('{"ok":"find"}');
    expect(ran.map((one) => one.door?.tool)).toEqual(['delete_resource']);
  });
});

describe('the stricter hook', () => {
  test('demands delete_resource for one call by its arguments, and the refusal names it', async () => {
    const mcp = server({ stricter });
    const small = await via(mcp, 'write_resource', { action: 'update', params: { amount: 5 } });
    expect(text(small)).toBe('{"ok":"update"}');
    const large = await via(mcp, 'write_resource', { action: 'update', params: { amount: 500 } });
    expect(text(large)).toStartWith('X_MCP_WRONG_TOOL: ');
    expect(text(large)).toContain('delete_resource({ resource: "crm", action: "update", params })');
    const read = await via(mcp, 'read_resource', { action: 'find', params: { id: 'secret' } });
    expect(text(read)).toContain('delete_resource({ resource: "crm", action: "find", params })');
    expect(ran.map((one) => one.args)).toEqual([{ amount: 5 }]);
    // Asked with the VALIDATED params, the effect and the door the call came through.
    expect(asked[1]).toMatchObject({
      tool: 'write_resource',
      resource: 'crm',
      action: 'update',
      effect: 'write',
      params: { amount: 500 },
      fields: {},
    });
    expect(asked[1]?.caller.actor.id).toBe('a1');
  });

  test('is never asked for arguments the schema refuses, nor for a caller the scope refuses', async () => {
    const mcp = server(
      { stricter },
      { tools: [...TOOLS.slice(0, 2), tool('remove', { effect: 'delete', scope: 'crm:delete' })] },
    );
    const invalid = await via(mcp, 'write_resource', { action: 'update', params: { id: 7 } });
    expect(isError(invalid)).toBe(true);
    const scoped = await via(mcp, 'delete_resource', { action: 'remove', params: {} });
    expect(JSON.stringify(scoped)).toContain('X_MCP_SCOPE_DENIED');
    expect(asked).toEqual([]);
  });

  test('anything but the literal false demands the stricter door, and a throw runs nothing', async () => {
    const lax = server({ stricter: (() => undefined) as unknown as () => boolean });
    const answer = await via(lax, 'write_resource', { action: 'update', params: {} });
    expect(text(answer)).toStartWith('X_MCP_WRONG_TOOL: ');
    const throwing = server({
      stricter: () => Promise.reject(new Error('rules table unreachable at db.internal')),
    });
    const failed = await via(throwing, 'write_resource', { action: 'update', params: {} });
    expect(JSON.stringify(failed)).not.toContain('db.internal');
    expect(failed?.error).toBeDefined();
    expect(ran).toEqual([]);
  });
});

describe('declared envelope fields', () => {
  const split: McpSplitOptions = {
    stricter,
    fields: {
      reason: { description: 'Why this call is made.', maxLength: 20 },
      ticket: { description: 'The change ticket.', tools: ['delete_resource'], required: true },
    },
  };

  test('a declared field reaches the hook, the handler’s door and the audit event, never the action input', async () => {
    const mcp = server(split);
    const answer = await via(mcp, 'write_resource', {
      action: 'update',
      params: { id: 'c1' },
      reason: 'customer asked',
    });
    expect(text(answer)).toBe('{"ok":"update"}');
    expect(asked[0]?.fields).toEqual({ reason: 'customer asked' });
    expect(ran).toEqual([
      {
        tool: 'update',
        args: { id: 'c1' },
        door: { tool: 'write_resource', fields: { reason: 'customer asked' } },
      },
    ]);
    const event = audits.at(-1);
    expect(event?.kind === 'tool-call' ? event.caller.door : undefined).toEqual({
      tool: 'write_resource',
      fields: { reason: 'customer asked' },
    });
  });

  test('an undeclared field, one declared for another dispatcher, and a bad value are refused', async () => {
    const mcp = server(split);
    for (const extra of [
      { note: 'x' },
      { ticket: 'T-1' },
      { reason: 7 },
      { reason: 'x'.repeat(21) },
    ]) {
      const answer = await via(mcp, 'write_resource', { action: 'update', params: {}, ...extra });
      expect(isError(answer)).toBe(true);
    }
    // Required where it is declared required: `delete_resource` here.
    const missing = await via(mcp, 'delete_resource', { action: 'remove', params: {} });
    expect(isError(missing)).toBe(true);
    expect(text(missing)).toContain('ticket');
    const given = await via(mcp, 'delete_resource', {
      action: 'remove',
      params: {},
      ticket: 'T-1',
    });
    expect(JSON.parse(text(given))).toMatchObject({ preview: true, params: {} });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
    // With no `split`, the envelope is as closed as it was.
    const closed = await via(server(), 'write_resource', {
      action: 'update',
      params: {},
      reason: 'x',
    });
    expect(isError(closed)).toBe(true);
  });

  test('tools/list publishes each field on the dispatchers that take it', async () => {
    const listed = (await server(split).handle(list, agent))?.result as {
      tools: {
        name: string;
        inputSchema: { properties: Record<string, unknown>; required: string[] };
      }[];
    };
    const schema = (name: string) => listed.tools.find((one) => one.name === name)?.inputSchema;
    expect(schema('write_resource')?.properties['reason']).toEqual({
      type: 'string',
      description: 'Why this call is made.',
      maxLength: 20,
    });
    expect(Object.hasOwn(schema('write_resource')?.properties ?? {}, 'ticket')).toBe(false);
    expect(schema('delete_resource')?.required).toEqual(['resource', 'action', 'ticket']);
    expect(Object.hasOwn(schema('list_resources')?.properties ?? {}, 'reason')).toBe(false);
    // Unchanged without the option, byte for byte.
    const plain = JSON.stringify((await server().handle(list, agent))?.result);
    expect(plain).not.toContain('reason');
    expect(plain).toBe(
      JSON.stringify(
        (
          await mcpServer({ surface: 'meta-split', groups: GROUPS, tools: TOOLS }).handle(
            list,
            agent,
          )
        )?.result,
      ),
    );
  });

  test('the audit line names the door and never a field', async () => {
    const lines: Record<string, unknown>[] = [];
    const release = installLogSink((line) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
    );
    try {
      await via(server(split), 'write_resource', {
        action: 'update',
        params: {},
        reason: 'customer asked',
      });
    } finally {
      release();
    }
    const line = lines.find((one) => one['msg'] === 'mcp.tool-call.ok');
    expect(line).toMatchObject({ tool: 'update', door: 'write_resource' });
    expect(JSON.stringify(lines)).not.toContain('customer asked');
  });
});

describe('boot refuses split options no call could use', () => {
  const boot = (split: McpSplitOptions, extra: Partial<McpServerInput> = {}): string => {
    try {
      server(split, extra);
    } catch (error) {
      const refusal = error as { code?: string; cause?: string };
      return `${refusal.code}: ${refusal.cause}`;
    }
    return 'booted';
  };

  test('a surface that is never meta-split', () => {
    expect(boot({ stricter }, { surface: 'meta' })).toContain('X_MCP_SPLIT_INVALID');
    expect(boot({ stricter }, { surface: () => 'meta-split' })).toBe('booted');
  });

  test('a field that is not a plain name, or one the envelope already owns', () => {
    for (const name of ['resource', 'params', 'live', 'confirmed_by_user', 'a b', '__proto__']) {
      const fields = JSON.parse(`{ "${name}": { "description": "x" } }`) as NonNullable<
        McpSplitOptions['fields']
      >;
      expect(boot({ fields })).toContain('X_MCP_SPLIT_INVALID');
    }
    expect(boot({ fields: { reason: { description: '' } } })).toContain('X_MCP_SPLIT_INVALID');
    expect(
      boot({ fields: { reason: { description: 'x', tools: ['list_resources' as never] } } }),
    ).toContain('X_MCP_SPLIT_INVALID');
    expect(boot({ stricter: 'yes' as never })).toContain('X_MCP_SPLIT_INVALID');
  });

  test('a field named as the tenant argument', () => {
    const tenant = { arg: 'project', resolve: () => null, list: () => [] };
    expect(boot({ fields: { project: { description: 'x' } } }, { tenant })).toContain(
      'X_MCP_TENANT_INVALID',
    );
  });
});

describe('through defineAppMcp', () => {
  beforeEach(() => definePermissions(['crm:use']));
  afterEach(clearPermissions);

  test('a hand-written tool and a runtime tool are handed the door beside their input', async () => {
    const seen: unknown[] = [];
    const { server: mcp } = defineAppMcp({
      surface: 'meta-split',
      groups: { crm: { description: 'The CRM', tools: ['update'] } },
      split: { fields: { reason: { description: 'Why.' } } },
      tools: {
        update: {
          description: 'Update a contact.',
          input: t.object({ id: t.string }),
          policy: 'crm:use',
          effect: 'write',
          handle: ({ input, door }) => {
            seen.push({ input, door });
            return { ok: true };
          },
        },
      },
      catalog: () => ({
        groups: { erp: { description: 'The ERP', tools: ['sync'] } },
        tools: [
          runtimeTool({
            name: 'sync',
            description: 'Sync a contact.',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            permission: 'crm:use',
            effect: 'write',
            run: ({ input, door }) => {
              seen.push({ input, door });
              return { ok: true };
            },
          }),
        ],
      }),
    });
    for (const [door, resource, action] of [
      ['write_resource', 'crm', 'update'],
      ['delete_resource', 'erp', 'sync'],
    ] as const) {
      const answer = await via(mcp, door, {
        resource,
        action,
        params: { id: 'c1' },
        reason: 'asked',
        live: true,
        confirmed_by_user: true,
      });
      // `write_resource` takes no `live`: its envelope is still closed to what it does not declare.
      if (door === 'write_resource') {
        expect(isError(answer)).toBe(true);
      }
    }
    const direct = await via(mcp, 'write_resource', {
      action: 'update',
      params: { id: 'c1' },
      reason: 'asked',
    });
    expect(text(direct)).toBe('{"ok":true}');
    expect(seen).toEqual([
      { input: { id: 'c1' }, door: { tool: 'delete_resource', fields: { reason: 'asked' } } },
      { input: { id: 'c1' }, door: { tool: 'write_resource', fields: { reason: 'asked' } } },
    ]);
  });
});
