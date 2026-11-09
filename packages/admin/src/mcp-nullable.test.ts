// A nullable column's MCP argument says so: `null` beside the field's own type, so the server's
// argument check lets an agent clear the column the way the form's empty box does. A NOT NULL one
// still refuses `null` before any handler runs. Driven through the real `McpServer`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import type { JsonRpcResponse, McpCaller } from '@ultimat3/mcp';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import { adminMcp } from './mcp';
import { adminTokenScopes } from './mcp-scopes';

const notes = entity('admin_mcp_nullable_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 40 }),
    body: text({ max: 200 }).nullable(),
    rank: integer().nullable(),
  },
});

afterAll(clearRegistry);

const db = database({ notes }, { driver: memoryDriver() });
let mcp: ReturnType<typeof adminMcp>;

beforeAll(() => {
  const app = defineAdmin({
    entities: [notes],
    db,
    auth: {
      actor: (): AdminActor | null => null,
      authz: staticAuthz([
        'admin:write',
        'admin_mcp_nullable_notes:read',
        'admin_mcp_nullable_notes:write',
      ]),
    },
  });
  mcp = adminMcp({ app, actor: (): AdminActor | null => null, requestId: () => 'req_nullable' });
});

const caller: McpCaller = {
  actor: agentActor({ id: 'agent' }),
  scopes: adminTokenScopes(undefined),
};

const TOOL = 'admin.admin_mcp_nullable_notes.create';

const propertyOf = (field: string): unknown => {
  const tool = mcp.tools.find((one) => one.name === TOOL);
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  return schema.properties?.[field];
};

const create = (args: Record<string, unknown>): Promise<JsonRpcResponse | null> =>
  mcp.server.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: args } },
    caller,
  );

describe("a nullable field's tool schema admits null", () => {
  test('a nullable text and integer say `null` beside their type', () => {
    expect(propertyOf('body')).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(propertyOf('rank')).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
  });

  test('a NOT NULL field is its type alone', () => {
    expect(propertyOf('title')).toEqual({ type: 'string' });
  });

  test('a create sending null to a nullable column stores it', async () => {
    const response = await create({ title: 'kept', body: null, rank: null });
    expect(response?.error).toBeUndefined();
    expect((response?.result as { isError?: boolean } | undefined)?.isError).toBeUndefined();
    const [row] = await db.notes.where({ title: 'kept' }).all();
    expect(row?.body).toBeNull();
    expect(row?.rank).toBeNull();
  });

  test('null for a NOT NULL column is still refused at the argument check', async () => {
    const response = await create({ title: null });
    const refused =
      response?.error !== undefined ||
      (response?.result as { isError?: boolean } | undefined)?.isError === true;
    expect(refused).toBe(true);
    expect(await db.notes.where({ title: 'kept' }).count()).toBe(1);
  });
});
