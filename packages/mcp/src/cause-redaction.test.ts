// What a 5xx a tool or a resource THREW tells a remote MCP caller: the code and a fixed sentence,
// never the cause — the verdict `packages/http/src/problem-redaction.test.ts` pins for the problem
// document. `X_DB_STATEMENT_FAILED` carries the server's message and the statement; the dev server
// (audience `'developer'`) keeps it, as HTTP's `dev: true` does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import {
  agentActor,
  createContext,
  registerPublicCause,
  resetPublicCauses,
  runWithContext,
  UltimateError,
} from '@ultimat3/core';
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
import type { McpServer } from './server';
import { createMcpServer } from './server';

/** What a driver error carries: the rejected row and the statement, in one cause. */
const LEAK =
  '[SQLSTATE 23505] duplicate key value violates unique constraint "users_email_key" DETAIL: ' +
  'Key (email)=(ada@example.test) already exists. — statement: INSERT INTO users';
const LEAK_FIX = 'psql "$DATABASE_URL" -c "INSERT INTO users"';

const statementFailed = (): UltimateError =>
  new UltimateError({ code: 'X_DB_STATEMENT_FAILED', cause: LEAK, fix: LEAK_FIX });

const caller: McpCaller = {
  actor: agentActor({ id: 'a1', orgId: 'o1', roles: ['member'] }),
  scopes: new Set<string>(),
};

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

const callTool = async (server: McpServer, name: string): Promise<string> => {
  const response = await inRequest(() =>
    server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
      caller,
    ),
  );
  const result = response?.result as { content?: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
};

const readResource = async (server: McpServer): Promise<string> => {
  const response = await inRequest(() =>
    server.handle(
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ultimate://boom' } },
      caller,
    ),
  );
  return JSON.stringify(response?.error);
};

const resourceServer = (audience: 'caller' | 'developer', thrown: () => unknown): McpServer =>
  createMcpServer({
    errorAudience: audience,
    resources: [
      {
        uri: 'ultimate://boom',
        name: 'boom',
        description: 'a resource whose provider fails',
        mimeType: 'text/plain',
        read: () => {
          throw thrown();
        },
      },
    ],
  });

beforeEach(() => {
  definePermissions(['user:insert']);
  defineRoles({ member: { grants: ['user:insert'] } });
  registerAction(
    'insertUser',
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('user:insert'),
      mcp: { expose: true, description: 'Insert a user' },
      handle: () => {
        throw statementFailed();
      },
    }),
  );
});

afterEach(() => {
  resetActions();
  resetPublicCauses();
  clearPermissions();
  clearRoles();
});

describe('a hidden 5xx over MCP', () => {
  test('a tool result carries the code and a fixed sentence, never the statement', async () => {
    const body = await callTool(defineAppMcp({ include: 'exposed' }).server, 'insertUser');
    expect(body).toStartWith('X_DB_STATEMENT_FAILED');
    expect(body).not.toContain('ada@example.test');
    expect(body).not.toContain('users_email_key');
    expect(body).not.toContain('INSERT INTO users');
    expect(body).toContain('  fix:   x errors explain X_DB_STATEMENT_FAILED --json');
  });

  test('a resource read error carries the same, in its data', async () => {
    const body = await readResource(resourceServer('caller', statementFailed));
    expect(body).toContain('X_DB_STATEMENT_FAILED');
    expect(body).not.toContain('ada@example.test');
    expect(body).not.toContain('INSERT INTO users');
  });

  test('the dev server (developer audience) keeps the whole thing', async () => {
    const body = await readResource(resourceServer('developer', statementFailed));
    expect(body).toContain('ada@example.test');
    expect(body).toContain(LEAK_FIX.replaceAll('"', '\\"'));
  });

  test('a code core declares public keeps its cause for a remote caller', async () => {
    registerPublicCause('X_APP_BUSY');
    const busy = () => new UltimateError({ code: 'X_APP_BUSY', cause: 'back off', fix: 'retry' });
    const body = await readResource(resourceServer('caller', busy));
    expect(body).toContain('back off');
  });

  test('a 4xx keeps its cause: the caller made it and is told what', async () => {
    const denied = () =>
      new UltimateError({ code: 'X_FORBIDDEN', cause: 'not your post', fix: 'ask' });
    const body = await readResource(resourceServer('caller', denied));
    expect(body).toContain('not your post');
  });
});
