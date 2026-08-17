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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  action,
  buildOpenApi,
  inputSchemaName,
  registerAction,
  resetRegistry as resetActions,
} from '@ultimat3/action';
import { agentActor } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
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
  scopes: [],
};

const declare = () =>
  action({
    input: Input,
    output: t.object({ ok: t.boolean }),
    policy: can('order:archive'),
    mcp: { expose: true, description: 'Archive an order' },
    handle: () => ({ ok: true }),
  });

describe('one declaration, three schema surfaces', () => {
  let archiveOrder: ReturnType<typeof declare>;

  beforeEach(() => {
    resetActions();
    clearRoles();
    clearPermissions();
    definePermissions(['order:archive']);
    defineRoles({ owner: ['order:archive'] });
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
    const response = await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { caller },
    );
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
    const openapi = props(openapiSchema()).orderRef as Record<string, unknown>;
    const tool = props(archiveOrder.tool().inputSchema).orderRef as Record<string, unknown>;
    const listed = props(await listedSchema()).orderRef as Record<string, unknown>;

    expect(openapi['pattern']).toBe(ORDER_REF.source);
    expect(tool['pattern']).toBe(ORDER_REF.source);
    // The one that was missing: an agent read `tools/list` and saw only the two lengths.
    expect(listed['pattern']).toBe(ORDER_REF.source);
  });

  test('`nullable` reaches every surface, and never by making the field optional', async () => {
    const nullBranch = { type: 'null' };

    const openapi = props(openapiSchema()).note as Record<string, unknown>;
    const tool = props(archiveOrder.tool().inputSchema).note as Record<string, unknown>;
    const listed = props(await listedSchema()).note as Record<string, unknown>;

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
