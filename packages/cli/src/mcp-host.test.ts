// The CLI's half of the MCP dev host: the tool catalog it exposes, the refusals that run before
// it, and the pure readers (`bun test` output, error codes, the resolved database) it owns.
// Driven against a fake `DevHost` so nothing here boots a database.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { createRecordingClient, READONLY_ROLE } from '@ultimat3/db';
import type { DatabaseTarget, DevHost, JsonRpcResponse, McpServer, ToolArgs } from '@ultimat3/mcp';
import { createMcpServer, devTools, resolveQueryLimits } from '@ultimat3/mcp';
import type { DevServices } from './dev-services';
import { loadCodeFixes } from './error-fixes';
import { CliNotImplementedError } from './errors';
import type { Runner } from './exec';
import { databaseTarget } from './mcp-db-target';
import { explainErrorCode } from './mcp-errors';
import { DEV_TOOL_SCOPES, lazyServices, localCaller, readOnlyRows } from './mcp-host';
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
      return { columns: [], rows: [], guards: ['txn:read-only'] };
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
    expect(textOf(response)).toContain('X_MCP_QUERY_REJECTED');
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
    expect(textOf(response)).toContain('X_MCP_NOT_BRANCH_DB');
    expect(textOf(response)).toContain('x db branch');
    expect(calls.runMigrations).toBe(0);
  });

  test('a branch database is migrated', async () => {
    const calls = noCalls();
    await call(serverFor(BRANCH, calls), 'db.migrate', {});
    expect(calls.runMigrations).toBe(1);
  });
});

describe('unit · the host runs layers 1 and 2 on the real connection', () => {
  const limits = resolveQueryLimits(2);

  test('the statement runs inside BEGIN READ ONLY, timed out, as the SELECT-only role', async () => {
    const db = createRecordingClient();
    const answer = await readOnlyRows(db, 'select id from posts', limits, READONLY_ROLE);
    expect(db.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${limits.timeoutMs}`,
      `SET LOCAL ROLE "${READONLY_ROLE}"`,
      'DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select id from posts',
      `FETCH FORWARD ${limits.maxRows + 1} FROM ultimate_read_cursor`,
      'ROLLBACK',
    ]);
    expect(answer.guards).toEqual([
      'txn:read-only',
      `timeout:${limits.timeoutMs}ms`,
      `role:${READONLY_ROLE}`,
      `fetch:${limits.maxRows + 1} rows`,
    ]);
  });

  test('the ceiling is asked of the SERVER, so a wide table is never paged into this process', async () => {
    const db = createRecordingClient();
    await readOnlyRows(db, 'select * from events', limits, null);

    // The bound that matters is on the FETCH, not on a slice afterwards: without it the driver
    // has already allocated every row in `events` by the time layer 4 gets to drop them.
    expect(db.texts).toContain(`FETCH FORWARD ${limits.maxRows + 1} FROM ultimate_read_cursor`);
    expect(db.texts).not.toContain('select * from events');
  });

  test('EXPLAIN and SHOW have no cursor form, so they still run directly', async () => {
    for (const statement of ['explain select 1', 'show statement_timeout']) {
      const db = createRecordingClient();
      const answer = await readOnlyRows(db, statement, limits, null);
      expect(db.texts).toContain(statement);
      expect(answer.guards.some((guard) => guard.startsWith('fetch:'))).toBe(false);
    }
  });

  test('no role means the layer is absent from guards, never assumed present', async () => {
    const db = createRecordingClient();
    const answer = await readOnlyRows(db, 'select 1', limits, null);
    expect(db.texts).not.toContain('SET LOCAL ROLE "ultimate_readonly"');
    expect(answer.guards.some((guard) => guard.startsWith('role:'))).toBe(false);
    // The transaction and the timeout still hold — one missing layer is not four.
    expect(answer.guards).toContain('txn:read-only');
  });

  test('one row past the ceiling comes back, so the tool can report truncation', async () => {
    // More rows than asked for: a server that over-delivers must still not widen the answer.
    const db = createRecordingClient().on('FETCH', {
      rows: Array.from({ length: 50 }, (_, id) => ({ id, title: `p${id}` })),
    });
    const answer = await readOnlyRows(db, 'select id, title from posts', limits, null);
    expect(answer.columns).toEqual(['id', 'title']);
    expect(answer.rows).toHaveLength(limits.maxRows + 1);
    expect(answer.rows[0]).toEqual([0, 'p0']);
  });

  test('the statement reaches the driver byte-for-byte', async () => {
    const db = createRecordingClient();
    const sql = "select 'delete from posts' as note";
    await readOnlyRows(db, sql, limits, null);
    // Inside the cursor now, but still verbatim — stripping it would run
    // `select   as note`.
    expect(db.texts).toContain(`DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR ${sql}`);
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

  // A code the CLI neither owns nor borrows. Its fix used to be the generic `x verify --json` —
  // true of the gate step and useless to anyone holding the code — and is now the text one of its
  // own throw sites writes, with the count of the others said out loud rather than hidden.
  // `createDevMcpServer` is what awaits the load in a real `x mcp serve`.
  test('a registered framework code explains with its own throw site', async () => {
    await loadCodeFixes();
    const explained = explainErrorCode('X_DB_DRIFT');
    expect(explained?.cause).toBe('schema differs from migrations');
    expect(explained?.docs).toBe(ERROR_DOCS_URL);
    expect(explained?.fix).toStartWith('x db gen ');
    expect(explained?.fix).toContain('X_DB_DRIFT is raised at ');
    // Reads every installed package's source once: `REPO_SCAN_TIMEOUT_MS`'s value, as a literal,
    // for the reason `error-catalog.test.ts` repeats it too — a package's own suite may not
    // import the host monorepo's `scripts/`.
  }, 30_000);

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
      {},
    );
    expect(target.label).not.toContain('hunter2');
    expect(target.label).toBe('postgres://db.internal:5432/shop');
  });

  test("the app's own dev database is not a branch", () => {
    expect(databaseTarget(services('pglite:///app/.x/pgdata', 'embedded'), {}).branch).toBeNull();
    expect(
      databaseTarget(services('postgres://db.internal:5432/shop', 'external'), {}).branch,
    ).toBeNull();
  });

  test('a branch is read from the name `x db branch` actually produces', () => {
    expect(databaseTarget(services('pglite:///app/.x/pgdata-feature', 'embedded'), {}).branch).toBe(
      'feature',
    );
    expect(
      databaseTarget(services('postgres://db.internal:5432/shop_branch_feature', 'external'), {})
        .branch,
    ).toBe('feature');
  });

  test('a developer machine is not production, whichever database it points at', () => {
    const dev = services('pglite:///app/.x/pgdata', 'embedded');
    expect(databaseTarget(dev, {}).production).toBe(false);
    expect(databaseTarget(dev, { ULTIMATE_ENV: 'development' }).production).toBe(false);
    expect(databaseTarget(dev, { NODE_ENV: 'test' }).production).toBe(false);
    // Staging is not production traffic, and `branch: null` is already what refuses it. Widening
    // this flag to mean "not development" would make the refusal say something untrue.
    expect(databaseTarget(dev, { ULTIMATE_ENV: 'staging' }).production).toBe(false);
  });

  test('a production environment says so — the arm that refuses it was unreachable', () => {
    // `production` was the literal `false` in both branches, so `assertBranchDatabase`'s FIRST
    // refusal — "production is never migratable from MCP at all" — could not run for any database
    // this CLI ever produced. A production database that happens to be named `<x>_branch_<y>`, or
    // a container whose data directory is `pgdata-<y>`, reads as a branch and was migratable.
    const prod = services('postgres://db.internal:5432/shop_branch_hotfix', 'external');
    expect(databaseTarget(prod, { ULTIMATE_ENV: 'production' }).production).toBe(true);
    expect(databaseTarget(prod, { NODE_ENV: 'production' }).production).toBe(true);
    // and the branch reading is unchanged — the two answers are independent.
    expect(databaseTarget(prod, { ULTIMATE_ENV: 'production' }).branch).toBe('hotfix');
  });

  test('an unreadable ULTIMATE_ENV counts as production, because the guard must fail closed', () => {
    // `tryResolveEnvironment` answers `undefined` for exactly one input: `ULTIMATE_ENV` set to
    // something that is not an environment. Reading that as "not production" would let the one
    // misconfiguration this guard exists to survive defeat it.
    const target = databaseTarget(services('postgres://db/shop_branch_x', 'external'), {
      ULTIMATE_ENV: 'Production',
    });
    expect(target.production).toBe(true);
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
