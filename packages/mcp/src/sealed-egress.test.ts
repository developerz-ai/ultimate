// What an agent receives from `tools/call` for an entity with sealed columns: an action's result
// and a query's rows, as the JSON-RPC response the server answers — text block and
// `structuredContent` alike. A query has no output parse and a loose action output has no entity
// schema, so neither can rely on `entity.$schema` dropping the column.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import { agentActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';

const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';
const SEALED = /x1\.[0-9a-f]{16}\./;

const accounts = entity('me_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    credential: text().sealed(),
    contact: text().sealed({ lookup: true }),
  },
});
type Account = typeof accounts.$row;

const table = database({ accounts }, { driver: memoryDriver() }).accounts;

const caller: McpCaller = {
  role: 'owner',
  actor: agentActor({ id: 'agent-1', roles: ['owner'] }),
  scopes: new Set(),
};

const first = async (): Promise<Account> => {
  const [row] = await table.all();
  if (row === undefined) return expect.unreachable('the fixture row was not seeded');
  expect(row.credential).toBe(CANARY);
  return row;
};

beforeAll(async () => {
  await table.insert({ name: 'Ada', credential: CANARY, contact: LOOKUP_CANARY });
});

afterAll(() => {
  resetActions();
  resetQueries();
  clearRegistry();
});

const clean = (bytes: string): void => {
  expect(bytes).toContain('Ada');
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(LOOKUP_CANARY);
  expect(bytes).not.toMatch(SEALED);
  expect(bytes).not.toContain('credential');
  expect(bytes).not.toContain('contact');
};

describe('unit · a sealed column reaches no agent', () => {
  test('tools/call for an action and for a query, as the response the server answers', async () => {
    const typed = registerAction(
      'sealedAccount',
      action({
        input: t.object({}),
        output: accounts.$schema,
        policy: allow(),
        mcp: { expose: true },
        handle: first,
      }),
    );
    const loose = registerAction(
      'sealedAccountLoose',
      action({
        input: t.object({}),
        output: t.record(t.string),
        policy: allow(),
        mcp: { expose: true },
        handle: first,
      }),
    );
    const rows = registerQuery(
      'sealedAccounts',
      query({
        input: t.object({}),
        policy: allow(),
        mcp: { expose: true },
        sql: () => from<Account>('me_accounts', () => table.all()),
      }),
    );
    const { server } = defineAppMcp({ actions: [typed, loose], queries: [rows] });

    for (const name of ['sealedAccount', 'sealedAccountLoose', 'sealedAccounts']) {
      const response = await server.handle(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        caller,
      );
      const result = response?.result as { isError?: boolean } | undefined;
      expect(response?.error).toBeUndefined();
      expect(result?.isError).not.toBe(true);
      clean(JSON.stringify(response));
    }
  });
});
