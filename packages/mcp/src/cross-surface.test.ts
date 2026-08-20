// Axiom 2 as an executable claim: ONE `action` declaration, and the three schema surfaces it
// projects to must describe the same input.
//
// Two surfaces published different contracts for one declaration and nothing noticed, because
// every existing test asserts one surface at a time:
//   - `nullable` reached none of them — the OpenAPI component said `{"type":"string"}` for a field
//     the action's own `output:` validator returns `null` from;
//   - `pattern` reached OpenAPI and `action.tool()` but NOT `tools/list`, the path an agent
//     actually reads, so the agent was given no way to know the format and got `X_INPUT_INVALID`
//     from the action's own parse.
// This file is the cross-surface assertion. A keyword the wire subset cannot enforce is a
// deliberate omission (`validate-args.ts` is what makes it a contract at all) — so the assertion
// is per keyword and states which surface owes what.
//
// The same claim applies to the tool's NAME, and nothing asserted it until 2026-08: this package
// serves `actionName(target)`/`queryName(target)` verbatim (`projectable.ts`), while `.tool()`,
// `x-ultimate.mcpTool` and `ActionDescriptor.mcp.tool` all published `toToolName(name)` —
// `publishPost` served, `publish_post` published. An agent that read the spec and issued
// `tools/call { name: 'publish_post' }` got ToolNotFound. Every existing test asserted one side
// or the other, never the two against each other, so the second block below compares each
// PUBLISHED name against the catalog the server actually answers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  action,
  buildOpenApi,
  inputSchemaName,
  registerAction,
  resetRegistry as resetActions,
} from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import { validateArgs } from './validate-args';
import type { JsonSchema } from './wire';

const ORDER_REF = /^ORD-\d{4}$/;

const Input = t.object({
  orderRef: t.string.min(1).max(8).pattern(ORDER_REF),
  // `nullable` is not `optional`: the field is REQUIRED and its value may be `null`.
  note: t.nullable(t.string),
});

const caller: McpCaller = {
  role: 'owner',
  actor: agentActor({ id: 'agent-1', orgId: 'o1', roles: ['owner'] }),
  // A SET, and empty on purpose: no tool declared here carries a `scope`, so the scope gate is
  // out of this file's question. An empty array is not a set and never was one.
  scopes: new Set(),
};

const declare = () =>
  action({
    input: Input,
    output: t.object({ ok: t.boolean }),
    policy: can('order:archive'),
    mcp: { expose: true, description: 'Archive an order' },
    handle: () => ({ ok: true }),
  });

/** A read, for the name block: the naming rule is one rule and both primitives obey it. */
const declareRead = () =>
  query({
    input: t.object({ orgId: t.string }),
    policy: can('order:archive'),
    mcp: { expose: true, description: 'Recently archived orders' },
    sql: () => from<{ id: string }>('orders', [{ id: 'o1' }]),
  });

describe('one declaration, three schema surfaces', () => {
  let archiveOrder: ReturnType<typeof declare>;

  beforeEach(() => {
    resetActions();
    clearRoles();
    clearPermissions();
    definePermissions(['order:archive']);
    // `{ grants: [...] }`, not a bare array: `expandRoles` reads `.grants` and a bare array
    // defines a role that grants nothing — invisible until something actually runs a policy.
    defineRoles({ owner: { grants: ['order:archive'] } });
    archiveOrder = registerAction('archiveOrder', declare());
  });

  afterEach(() => {
    resetActions();
    clearRoles();
    clearPermissions();
  });

  /** The bytes an agent reads: the component the spec `$ref`s, not the operation's pointer. */
  const openapiSchema = (): Record<string, unknown> =>
    buildOpenApi().components.schemas[inputSchemaName('archiveOrder')] ?? {};

  const listedSchema = async (): Promise<JsonSchema> => {
    const { server } = defineAppMcp({ actions: [archiveOrder] });
    // `handle` takes the caller itself, not a wrapper: `{ caller }` carries no `actor`, which
    // `tools/list` never reads and `tools/call` dereferences on its way to the audit line.
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, caller);
    const result = response?.result as
      | { tools?: { name: string; inputSchema: JsonSchema }[] }
      | undefined;
    const tool = (result?.tools ?? []).find((entry) => entry.name === 'archiveOrder');
    // An absent tool is a failed assertion, not a thrown Error: `tools/list` answering nothing is
    // exactly the drift this file exists to report, and it must report it as a test failure.
    expect(tool).toBeDefined();
    return tool?.inputSchema ?? {};
  };

  const props = (schema: { properties?: unknown }): Record<string, unknown> =>
    (schema.properties ?? {}) as Record<string, unknown>;

  test('`pattern` reaches every surface an agent or a client reads', async () => {
    const openapi = props(openapiSchema())['orderRef'] as Record<string, unknown>;
    const tool = props(archiveOrder.tool().inputSchema)['orderRef'] as Record<string, unknown>;
    const listed = props(await listedSchema())['orderRef'] as Record<string, unknown>;

    expect(openapi['pattern']).toBe(ORDER_REF.source);
    expect(tool['pattern']).toBe(ORDER_REF.source);
    // The one that was missing: an agent read `tools/list` and saw only the two lengths.
    expect(listed['pattern']).toBe(ORDER_REF.source);
  });

  test('`nullable` reaches every surface, and never by making the field optional', async () => {
    const nullBranch = { type: 'null' };

    const openapi = props(openapiSchema())['note'] as Record<string, unknown>;
    const tool = props(archiveOrder.tool().inputSchema)['note'] as Record<string, unknown>;
    const listed = props(await listedSchema())['note'] as Record<string, unknown>;

    for (const projected of [openapi, tool, listed]) {
      expect(projected['anyOf']).toContainEqual(nullBranch);
    }

    // nullable ≠ optional, on every surface.
    expect(openapiSchema()['required']).toContain('note');
    expect(archiveOrder.tool().inputSchema['required']).toContain('note');
    expect((await listedSchema()).required).toContain('note');
  });

  // A keyword the server publishes and does not enforce is worse than one it omits: the agent
  // obeys a rule nothing checks and gets a silent pass. So `tools/list` publishing `pattern`
  // obliges `validate-args` to hold a call to it.
  test('the published `pattern` is the one the server enforces', async () => {
    const schema = await listedSchema();

    expect(validateArgs(schema, { orderRef: 'ORD-1234', note: null }).ok).toBe(true);
    expect(validateArgs(schema, { orderRef: 'nope', note: null })).toMatchObject({
      ok: false,
      issues: [{ path: 'orderRef' }],
    });
  });
});

describe('one declaration, ONE tool name', () => {
  let archiveOrder: ReturnType<typeof declare>;
  let recentOrders: ReturnType<typeof declareRead>;

  beforeEach(() => {
    resetActions();
    resetQueries();
    clearRoles();
    clearPermissions();
    definePermissions(['order:archive']);
    defineRoles({ owner: { grants: ['order:archive'] } });
    archiveOrder = registerAction('archiveOrder', declare());
    recentOrders = registerQuery('recentOrders', declareRead());
  });

  afterEach(() => {
    resetActions();
    resetQueries();
    clearRoles();
    clearPermissions();
  });

  const appMcp = () => defineAppMcp({ actions: [archiveOrder], queries: [recentOrders] });

  /** The names `tools/call` answers to — read off the catalog, never assumed from an export. */
  const servedNames = async (): Promise<readonly string[]> => {
    const response = await appMcp().server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      caller,
    );
    const result = response?.result as { tools?: { name: string }[] } | undefined;
    return (result?.tools ?? []).map((tool) => tool.name);
  };

  /** The operation as the published document carries it, located by id rather than by path. */
  const openapiMcpTool = (): string | undefined => {
    for (const item of Object.values(buildOpenApi().paths)) {
      const operation = (item as { post?: Record<string, unknown> }).post;
      if (operation?.['operationId'] === 'archiveOrder') {
        const published = (operation['x-ultimate'] as Record<string, unknown> | undefined)?.[
          'mcpTool'
        ];
        // Checked, not asserted: the document is `unknown` here, and a published name that is not
        // a string is a name no `tools/call` can ever resolve — which is this block's whole claim.
        return typeof published === 'string' ? published : undefined;
      }
    }
    return undefined;
  };

  test('every surface that PUBLISHES a tool name publishes one the server answers to', async () => {
    const served = await servedNames();

    // The served name is the export name VERBATIM — no derivation, on either side.
    expect([...served].sort()).toEqual(['archiveOrder', 'recentOrders']);
    // The three an action publishes. Each was `archive_order` until 2026-08, and none of the
    // three is a name this catalog has ever contained.
    expect(served).toContain(archiveOrder.tool().name);
    // Asserted defined first: `toContain(undefined)` would be a comparison against nothing, and a
    // missing `x-ultimate.mcpTool` is exactly one of the drifts this file reports.
    const published = openapiMcpTool();
    expect(published).toBeDefined();
    expect(served).toContain(published ?? '');
    expect(served).toContain(archiveOrder.describe().mcp.tool);
    // A query publishes one; `QueryDescriptor` carries no `mcp` block, so there is no fourth.
    expect(served).toContain(recentOrders.tool().name);
  });

  // The failure end to end, and the reason the assertion above is not enough on its own: an
  // agent reads `x-ultimate.mcpTool` out of `openapi.json` and calls exactly that name.
  test('the name OpenAPI publishes is a name tools/call resolves', async () => {
    const name = openapiMcpTool();
    const response = await runWithContext(createContext({}), () =>
      appMcp().server.handle(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: { orderRef: 'ORD-1234', note: null } },
        },
        caller,
      ),
    );

    // `-32601` ToolNotFound is what the published name actually got. Not a policy question:
    // this caller holds `order:archive`, so a resolved tool answers with the handler's value.
    expect(response?.error).toBeUndefined();
    const result = response?.result as
      | { isError?: boolean; content?: { text?: string }[] }
      | undefined;
    expect(result?.isError).toBeUndefined();
    expect(result?.content?.[0]?.text ?? '').toContain('"ok": true');
  });
});
