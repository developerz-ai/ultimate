// `defineAppMcp({ catalog })` end to end: a per-caller catalog resolved per request, served under
// the same gates as a static tool, and refused whole — never served smaller — when it cannot be.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { McpRuntimeCatalog } from './app-catalog';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import { runtimeTool } from './runtime-tool';
import type { JsonRpcResponse } from './wire';
import { INTERNAL_ERROR, METHOD_NOT_FOUND } from './wire';

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };

const names = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
    (t) => t.name,
  );
const textOf = (response: JsonRpcResponse | null): string =>
  ((response?.result as { content?: { text: string }[] } | undefined)?.content ?? [])[0]?.text ??
  '';
const errorData = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.error?.data ?? {}) as Record<string, unknown>;

const as = (id: string, orgId: string, roles: readonly string[]): McpCaller => ({
  actor: agentActor({ id, orgId, roles: [...roles] }),
  scopes: new Set(),
});
const ada = as('ada', 'acme', ['owner']);
const kenji = as('kenji', 'acme', ['reader']);
const bea = as('bea', 'beta', ['owner']);

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

/** One connector row per org — what an app reads from a table. */
const CONNECTORS = new Map([
  [
    'acme',
    [{ name: 'acme_crm', schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  ],
  ['beta', [{ name: 'beta_erp', schema: { type: 'object', properties: {} } }]],
]);

let resolved = 0;
let ran: unknown[] = [];

const connectors = (caller: McpCaller): McpRuntimeCatalog => {
  resolved += 1;
  return {
    tools: (CONNECTORS.get(caller.actor.orgId ?? '') ?? []).map((row) =>
      runtimeTool({
        name: row.name,
        description: `Search ${row.name}. Read-only.`,
        inputSchema: row.schema,
        permission: 'connector:call',
        destructive: false,
        run: ({ input, ctx }) => {
          ran.push({ input, actor: ctx.actor.id });
          return { hits: [] };
        },
      }),
    ),
  };
};

const seatReport = {
  description: 'Seats. Read-only.',
  input: t.object({}),
  policy: 'connector:call' as const,
  destructive: false,
  handle: () => ({ seats: 3 }),
};

beforeEach(() => {
  resolved = 0;
  ran = [];
  definePermissions(['connector:call']);
  defineRoles({ owner: { grants: ['connector:call'] }, reader: { grants: [] } });
});
afterEach(() => {
  clearPermissions();
  clearRoles();
});

describe('a per-caller catalog', () => {
  test('tools/list is resolved per caller, beside the static tools, and never cached', async () => {
    const { server } = defineAppMcp({ tools: { seatReport }, catalog: connectors });
    expect(names(await server.handle(list, ada))).toEqual(['acme_crm', 'seatReport']);
    expect(names(await server.handle(list, bea))).toEqual(['beta_erp', 'seatReport']);
    expect(names(await server.handle(list, ada))).toEqual(['acme_crm', 'seatReport']);
    expect(resolved).toBe(3);
  });

  test('a runtime tool runs as the caller, with its input validated', async () => {
    const { server } = defineAppMcp({ catalog: connectors });
    const answer = await inRequest(() => server.handle(call('acme_crm', { q: 'x' }), ada));
    expect(textOf(answer)).toBe('{"hits":[]}');
    expect(ran).toEqual([{ input: { q: 'x' }, actor: 'ada' }]);
  });

  test("another caller's runtime tool answers exactly what an absent tool answers", async () => {
    const { server } = defineAppMcp({ catalog: connectors });
    const foreign = await server.handle(call('acme_crm'), bea);
    const absent = await server.handle(call('nope_tool'), bea);
    expect(foreign?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(foreign).replace('acme_crm', 'nope_tool')).toBe(JSON.stringify(absent));
    expect(ran).toEqual([]);
  });

  test('the borrowed permission decides, before the arguments are read', async () => {
    const { server } = defineAppMcp({ catalog: connectors });
    // A reader of the same org: the tool is listed (the resolver's call), the policy refuses —
    // and bad arguments still get the denial, never the schema's issue list.
    const denied = await inRequest(() => server.handle(call('acme_crm', { q: 7 }), kenji));
    expect(textOf(denied)).toContain('X_FORBIDDEN');
    expect(ran).toEqual([]);
  });

  test('a name a static tool already answers to fails the request, naming the code', async () => {
    const { server } = defineAppMcp({
      tools: { acme_crm: seatReport },
      catalog: connectors,
    });
    const listed = await server.handle(list, ada);
    expect(listed?.error?.code).toBe(INTERNAL_ERROR);
    expect(errorData(listed)['code']).toBe('X_MCP_CATALOG_TOOL_DUPLICATE');
    // tools/call too: a duplicate is never resolved to whichever copy came first.
    expect(textOf(await inRequest(() => server.handle(call('acme_crm'), ada)))).toContain(
      'X_MCP_CATALOG_TOOL_DUPLICATE',
    );
  });

  test('two runtime tools of one name, or one named like a meta tool, fail the request', async () => {
    const twice = (name: string) => () => ({
      tools: [1, 2].map(() =>
        runtimeTool({
          name,
          description: 'x',
          inputSchema: { type: 'object' },
          permission: 'connector:call',
          run: () => null,
        }),
      ),
    });
    const { server } = defineAppMcp({ catalog: twice('dup') });
    expect(errorData(await server.handle(list, ada))['code']).toBe('X_MCP_CATALOG_TOOL_DUPLICATE');
    // One tool alone, on a FLAT server: the meta names are reserved whatever the surface.
    const meta = defineAppMcp({
      catalog: () => ({ tools: twice('list_resources')().tools.slice(1) }),
    });
    expect(errorData(await meta.server.handle(list, ada))['code']).toBe(
      'X_MCP_CATALOG_TOOL_DUPLICATE',
    );
  });

  test('a resolver that throws fails the request — its cause hidden from a remote caller', async () => {
    const { server } = defineAppMcp({
      tools: { seatReport },
      catalog: () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432')),
    });
    const listed = await server.handle(list, ada);
    expect(listed?.error?.code).toBe(INTERNAL_ERROR);
    expect(errorData(listed)['code']).toBe('X_MCP_CATALOG_UNRESOLVED');
    expect(JSON.stringify(listed)).not.toContain('db.internal');
    // Every name answers the same while it is down — a static one too — so no name is an oracle.
    const onStatic = await inRequest(() => server.handle(call('seatReport'), ada));
    const onAbsent = await inRequest(() => server.handle(call('nope_tool'), ada));
    expect(textOf(onStatic)).toContain('X_MCP_CATALOG_UNRESOLVED');
    expect(textOf(onStatic)).toBe(textOf(onAbsent));
  });

  test('an entry not built by runtimeTool() is refused: no tool skips the permission', async () => {
    const forged = {
      name: 'forged',
      description: 'no policy',
      inputSchema: { type: 'object' },
      handle: () => Promise.resolve({ content: [] }),
    };
    const { server } = defineAppMcp({
      errorAudience: 'developer',
      catalog: () => ({ tools: [forged as unknown as ReturnType<typeof runtimeTool>] }),
    });
    const listed = errorData(await server.handle(list, ada));
    expect(listed['code']).toBe('X_MCP_CATALOG_UNRESOLVED');
    expect(listed['cause']).toContain('not built by runtimeTool()');
  });

  test('scopes: a runtime tool must name a declared scope, and its gate is outcome 2', async () => {
    const scoped = (scope: string | undefined) => () => ({
      tools: [
        runtimeTool({
          name: 'crm',
          description: 'x',
          inputSchema: { type: 'object' },
          permission: 'connector:call',
          ...(scope === undefined ? {} : { scope }),
          run: () => null,
        }),
      ],
    });
    const scopes = { 'connectors:call': ['seatReport'] };
    const refusals = [
      [undefined, 'names no scope'],
      ['undeclared', 'which scopes: does not declare'],
    ] as const;
    for (const [scope, why] of refusals) {
      const { server } = defineAppMcp({
        errorAudience: 'developer',
        tools: { seatReport },
        scopes,
        catalog: scoped(scope),
      });
      const listed = errorData(await server.handle(list, ada));
      expect(listed['code']).toBe('X_MCP_CATALOG_UNRESOLVED');
      expect(listed['cause']).toContain(why);
    }
    const { server } = defineAppMcp({
      tools: { seatReport },
      scopes,
      catalog: scoped('connectors:call'),
    });
    const refused = await server.handle(call('crm'), ada);
    expect(errorData(refused)['code']).toBe('X_MCP_SCOPE_DENIED');
    const held = { ...ada, scopes: new Set(['connectors:call']) };
    expect(textOf(await inRequest(() => server.handle(call('crm'), held)))).toBe('null');
  });

  test('on a meta surface, resolved groups are resources list_resources shows per caller', async () => {
    const { server } = defineAppMcp({
      tools: { seatReport },
      surface: 'meta',
      groups: { seats: { description: 'Seats', tools: ['seatReport'] } },
      catalog: (caller) => {
        const own = connectors(caller);
        return {
          tools: own.tools,
          groups: {
            connectors: { description: 'Connectors', tools: own.tools.map((x) => x.name) },
          },
        };
      },
    });
    const catalogOf = async (who: McpCaller) =>
      textOf(await inRequest(() => server.handle(call('list_resources'), who)));
    expect(await catalogOf(ada)).toContain('acme_crm');
    expect(await catalogOf(bea)).not.toContain('acme_crm');
    const ran1 = await inRequest(() =>
      server.handle(
        call('manage_resource', { resource: 'connectors', action: 'acme_crm', params: {} }),
        ada,
      ),
    );
    expect(textOf(ran1)).toBe('{"hits":[]}');
    // A resolved resource may not take a boot group's name.
    const clash = defineAppMcp({
      tools: { seatReport },
      surface: 'meta',
      groups: { seats: { description: 'Seats', tools: ['seatReport'] } },
      catalog: () => ({ tools: [], groups: { seats: { description: 'again', tools: [] } } }),
    });
    expect(errorData(await clash.server.handle(list, ada))['code']).toBe(
      'X_MCP_CATALOG_TOOL_DUPLICATE',
    );
  });
});
