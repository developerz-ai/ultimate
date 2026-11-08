// A `json()` column's MCP argument is typed by the column's OWN schema — an array, an object, a
// value that admits `null` — or left untyped where none can be derived. A blanket `type: 'object'`
// made the server's argument check refuse every array column and every JSON `null` before the
// entity's schema, the one judge of the value, was asked. Driven through the real `McpServer`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import {
  arrayOf,
  clearRegistry,
  database,
  entity,
  json,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import type { JsonRpcResponse, McpCaller } from '@ultimat3/mcp';
import { type StandardSchemaV1, t } from '@ultimat3/schema';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import { adminMcp } from './mcp';
import { adminTokenScopes } from './mcp-scopes';

const shape = t.object({ a: t.number });

/** A Standard Schema no provider can introspect: the tool cannot say what it takes. */
const opaque: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'elsewhere', validate: (value) => ({ value }) },
};

const docs = entity('admin_mcp_json_docs', {
  columns: {
    id: uuid().primaryKey(),
    tags: json(t.array(t.string)),
    payload: json(t.nullable(shape)),
    settings: json(shape),
    note: json(shape).nullable(),
    labels: arrayOf(text({ max: 20 })),
    raw: json(opaque),
    either: json(t.nullable(shape)).nullable(),
  },
});

afterAll(clearRegistry);

const db = database({ docs }, { driver: memoryDriver() });
let mcp: ReturnType<typeof adminMcp>;

beforeAll(() => {
  const app = defineAdmin({
    entities: [docs],
    db,
    auth: {
      actor: (): AdminActor | null => null,
      authz: staticAuthz(['admin:write', 'admin_mcp_json_docs:read', 'admin_mcp_json_docs:write']),
    },
  });
  mcp = adminMcp({ app, actor: (): AdminActor | null => null, requestId: () => 'req_json' });
});

const caller: McpCaller = {
  actor: agentActor({ id: 'agent' }),
  scopes: adminTokenScopes(undefined),
};

const propertyOf = (field: string): unknown => {
  const tool = mcp.tools.find((one) => one.name === 'admin.admin_mcp_json_docs.create');
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  return schema.properties?.[field];
};

const create = (args: Record<string, unknown>): Promise<JsonRpcResponse | null> =>
  mcp.server.handle(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'admin.admin_mcp_json_docs.create', arguments: args },
    },
    caller,
  );

describe("a json field's tool schema is the column's schema", () => {
  test('an array column says array', () => {
    expect(propertyOf('tags')).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(propertyOf('labels')).toMatchObject({ type: 'array' });
  });

  test('an object column still says object', () => {
    expect(propertyOf('settings')).toMatchObject({ type: 'object' });
  });

  test('a NOT NULL column whose schema admits null admits null', () => {
    const schema = propertyOf('payload') as { anyOf?: readonly { type?: string }[] };
    expect(schema.anyOf?.map((branch) => branch.type)).toEqual(['object', 'null']);
  });

  test('a nullable column admits null beside its shape', () => {
    const schema = propertyOf('note') as { anyOf?: readonly { type?: string }[] };
    expect(schema.anyOf?.map((branch) => branch.type)).toEqual(['object', 'null']);
  });

  test('a nullable column whose schema already admits null is not wrapped twice', () => {
    expect(propertyOf('either')).toEqual(propertyOf('payload'));
  });

  test('a schema that cannot be described leaves the argument untyped, never `object`', () => {
    expect(propertyOf('raw')).toEqual({});
  });

  test('the server accepts an array and a JSON null, and the row holds them', async () => {
    const response = await create({
      tags: ['a', 'b'],
      payload: null,
      settings: { a: 1 },
      labels: ['x'],
      raw: [1, 'two'],
    });
    expect(response?.error).toBeUndefined();
    const result = response?.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBeUndefined();
    const [row] = await db.docs.all();
    expect(row?.tags).toEqual(['a', 'b']);
    expect(row?.payload).toBeNull();
  });
});
