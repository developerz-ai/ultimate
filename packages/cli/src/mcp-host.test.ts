// The CLI's half of the MCP dev host: the tool catalog it exposes, the refusals that run before
// it, and the pure readers (`bun test` output, error codes, the resolved database) it owns.
// Driven against a fake `DevHost` so nothing here boots a database.

import { describe, expect, test } from 'bun:test';
import type { DatabaseTarget, DevHost, JsonRpcResponse, McpServer, ToolArgs } from '@ultimat3/mcp';
import { createMcpServer, devTools } from '@ultimat3/mcp';
import type { DevServices } from './dev-services';
import { CliNotImplementedError } from './errors';
import type { Runner } from './exec';
import { databaseTarget } from './mcp-db-target';
import { explainErrorCode } from './mcp-errors';
import { DEV_TOOL_SCOPES, lazyServices, localCaller } from './mcp-host';
import { parseBunTest } from './mcp-test-output';

/** Every tool `@ultimat3/mcp` ships for dev, in `tools/list` order. */
const TOOL_NAMES = [
  'actions.describe',
  'db.migrate',
  'db.query',
  'errors.explain',
  'jobs.inspect',
  'logs.tail',
  'manifest.read',
  'policies.list',
  'queue.depth',
  'routes.list',
  'schema.describe',
  'tests.run',
  'verify.run',
] as const;

interface HostCalls {
  runQuery: number;
  runMigrations: number;
}

const BRANCH: DatabaseTarget = {
  label: 'app_branch_feature',
  branch: 'feature',
  production: false,
};
const SHARED: DatabaseTarget = { label: 'app', branch: null, production: false };

function fakeHost(database: DatabaseTarget, calls: HostCalls): DevHost {
  return {
    routes: () => [],
    entities: () => [],
    actions: () => [],
    queries: () => [],
    policies: () => [],
    jobs: () => [],
    jobInspect: () => ({}),
    database,
    async runQuery() {
      calls.runQuery += 1;
      return { columns: [], rows: [], rowCount: 0, truncated: false };
    },
    async runMigrations(branch: string) {
      calls.runMigrations += 1;
      return { branch, applied: [], pending: [] };
    },
    async queueDepth() {
      return [];
    },
    async runTests() {
      return { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] };
    },
    async tailLogs() {
      return [];
    },
    async readManifest() {
      return '{}';
    },
    explainError: () => undefined,
    async verify() {
      return { ok: true, steps: [] };
    },
  };
}

const serverFor = (database: DatabaseTarget, calls: HostCalls): McpServer =>
  createMcpServer({ tools: devTools(fakeHost(database, calls)) });

const noCalls = (): HostCalls => ({ runQuery: 0, runMigrations: 0 });

const call = (
  server: McpServer,
  name: string,
  args: ToolArgs = {},
): Promise<JsonRpcResponse | null> =>
  server.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    localCaller(),
  );

const textOf = (response: JsonRpcResponse | null): string => {
  const result = response?.result as
    | { content?: readonly { readonly text?: string }[]; isError?: boolean }
    | undefined;
  return result?.content?.[0]?.text ?? '';
};

const isErrorResult = (response: JsonRpcResponse | null): boolean =>
  (response?.result as { isError?: boolean } | undefined)?.isError === true;

describe('unit · the dev tool catalog', () => {
  test('every dev tool is reachable by the local caller, by name', () => {
    const server = serverFor(BRANCH, noCalls());
    expect(server.tools.names(localCaller())).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toHaveLength(13);
  });

  test('exactly the mutating tools bill the write bucket', () => {
    const server = serverFor(BRANCH, noCalls());
    const mutating = server.tools
      .names(localCaller())
      .filter((name) => server.tools.verbClass(name) === 'write');
    expect(mutating).toEqual(['db.migrate', 'tests.run', 'verify.run']);
  });

  test('every tool the catalog lists carries an argument schema', () => {
    const server = serverFor(BRANCH, noCalls());
    for (const tool of server.list(localCaller())) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe('unit · db.query refuses structurally, before the host runs', () => {
  test.each([
    ['a write', 'insert into posts (id) values (1)'],
    ['a second statement', 'select 1; delete from posts'],
    ['a locking clause', 'select * from posts for update'],
  ])('%s never reaches runQuery', async (_label, sql) => {
    const calls = noCalls();
    const response = await call(serverFor(BRANCH, calls), 'db.query', { sql });
    expect(textOf(response)).toContain('X_MCP_READONLY_VIOLATION');
    expect(isErrorResult(response)).toBe(true);
    expect(calls.runQuery).toBe(0);
  });

  test('a read reaches the host', async () => {
    const calls = noCalls();
    const response = await call(serverFor(BRANCH, calls), 'db.query', { sql: 'select 1' });
    expect(isErrorResult(response)).toBe(false);
    expect(calls.runQuery).toBe(1);
  });
});

describe('unit · db.migrate refuses a non-branch target', () => {
  test('a shared database never reaches runMigrations', async () => {
    const calls = noCalls();
    const response = await call(serverFor(SHARED, calls), 'db.migrate', {});
    expect(textOf(response)).toContain('X_MCP_READONLY_VIOLATION');
    expect(textOf(response)).toContain('x db branch');
    expect(calls.runMigrations).toBe(0);
  });

  test('a branch database is migrated', async () => {
    const calls = noCalls();
    await call(serverFor(BRANCH, calls), 'db.migrate', {});
    expect(calls.runMigrations).toBe(1);
  });
});

// Captured from `bun test` 1.3.x verbatim — a hand-written summary would test the fixture.
const PASSING = `bun test v1.3.14 (0d9b296a)

 12 pass
 0 fail
 28 expect() calls
Ran 12 tests across 1 file. [64.00ms]`;

const FAILING = `bun test v1.3.14 (0d9b296a)

sample.test.ts:
3 | describe('outer group', () => {
7 |   test('fails loudly', () => {
8 |     expect(1).toBe(2);
                  ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bunfixture/sample.test.ts:8:15)
(fail) outer group > fails loudly [0.24ms]

 1 pass
 1 skip
 1 todo
 1 fail
 2 expect() calls
Ran 4 tests across 1 file. [17.00ms]`;

describe('unit · parseBunTest reads the runner, it does not guess', () => {
  test('a passing run', () => {
    expect(parseBunTest(PASSING, 640)).toEqual({
      passed: 12,
      failed: 0,
      skipped: 0,
      durationMs: 640,
      failures: [],
    });
  });

  test('a failing run names the test and its message', () => {
    const run = parseBunTest(FAILING, 170);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    // `skip` and `todo` are both "not run".
    expect(run.skipped).toBe(2);
    expect(run.failures).toEqual([
      { test: 'outer group > fails loudly', message: 'expect(received).toBe(expected)' },
    ]);
  });

  test('output it cannot parse is a FAILED run carrying the tail, never a green zero', () => {
    const run = parseBunTest('bun: command not found\nsegmentation fault', 12);
    expect(run.failed).toBe(1);
    expect(run.passed).toBe(0);
    expect(run.failures[0]?.message).toContain('command not found');
  });

  test('no output at all still fails', () => {
    const run = parseBunTest('', 0);
    expect(run.failed).toBe(1);
    expect(run.failures[0]?.message).toBe('bun test produced no output');
  });
});

describe('unit · errors.explain', () => {
  test('a code nobody registered has no explanation to invent', () => {
    expect(explainErrorCode('X_NOT_A_REAL_CODE')).toBeUndefined();
  });

  test('a registered framework code explains with its registered title', () => {
    expect(explainErrorCode('X_CONFIG_INVALID')).toEqual({
      code: 'X_CONFIG_INVALID',
      cause: 'app.config.ts is invalid',
      fix: 'x verify --json',
      docs: 'https://ultimate.dev/errors/X_CONFIG_INVALID',
    });
  });

  test("a CLI code answers with the CLI's own runnable fix", () => {
    expect(explainErrorCode('X_VERIFY_FAILED')?.fix).toBe('x verify --json');
    expect(explainErrorCode('X_BUN_VERSION')?.fix).toBe('bun upgrade');
  });
});

describe('unit · the local caller', () => {
  test('is an agent, because both transports must resolve to the same kind', () => {
    expect(localCaller().actor.kind).toBe('agent');
  });

  test('carries every dev scope', () => {
    expect([...DEV_TOOL_SCOPES].sort()).toEqual([
      'db:migrate',
      'db:read',
      'dev:logs',
      'dev:read',
      'dev:test',
    ]);
    for (const scope of DEV_TOOL_SCOPES) expect(localCaller().scopes.has(scope)).toBe(true);
  });
});

const services = (url: string, mode: 'embedded' | 'external'): DevServices => ({
  stateDir: '/app/.x',
  db: { name: 'db', mode, url, detail: 'test' },
  events: { name: 'events', mode: 'embedded', url: 'inproc://events', detail: 'test' },
  storage: { name: 'storage', mode: 'embedded', url: 'file:///app/.x/storage', detail: 'test' },
});

describe('unit · the database target', () => {
  test('an external url never carries its password into the label', () => {
    const target = databaseTarget(
      services('postgres://joe:hunter2@db.internal:5432/shop', 'external'),
    );
    expect(target.label).not.toContain('hunter2');
    expect(target.label).toBe('postgres://db.internal:5432/shop');
  });

  test("the app's own dev database is not a branch", () => {
    expect(databaseTarget(services('pglite:///app/.x/pgdata', 'embedded')).branch).toBeNull();
    expect(
      databaseTarget(services('postgres://db.internal:5432/shop', 'external')).branch,
    ).toBeNull();
  });

  test('a branch is read from the name `x db branch` actually produces', () => {
    expect(databaseTarget(services('pglite:///app/.x/pgdata-feature', 'embedded')).branch).toBe(
      'feature',
    );
    expect(
      databaseTarget(services('postgres://db.internal:5432/shop_branch_feature', 'external'))
        .branch,
    ).toBe('feature');
  });

  test('nothing `x dev` resolves is production — the branch gate is what refuses', () => {
    expect(databaseTarget(services('pglite:///app/.x/pgdata', 'embedded')).production).toBe(false);
  });
});

const noRunner: Runner = (command) => {
  throw new CliNotImplementedError({
    feature: `a subprocess in this test (${command.join(' ')})`,
    fix: 'x mcp tools --json',
  });
};

describe('unit · the lazily booted services', () => {
  test('a tool call after close() is refused instead of booting a database nobody stops', async () => {
    const lazy = lazyServices({ root: '/tmp/nonexistent-app', env: {}, runner: noRunner });
    await lazy.close();
    expect(() => lazy.running()).toThrow(/X_NOT_IMPLEMENTED/);
  });

  test('close() is idempotent, so both transports may call it on the way out', async () => {
    const lazy = lazyServices({ root: '/tmp/nonexistent-app', env: {}, runner: noRunner });
    await lazy.close();
    await lazy.close();
    expect(lazy.services.db.url).toContain('pglite://');
  });
});
