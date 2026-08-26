import { describe, expect, test } from 'bun:test';
import type { SqlRunner } from './template-db';
import {
  acquireWorkerDatabase,
  cloneSql,
  createTemplateSql,
  DEFAULT_TEMPLATE,
  databaseNameFor,
  dropSql,
  lockSql,
  unlockSql,
  urlFor,
  workerId,
} from './template-db';

const ADMIN = 'postgres://user:pw@localhost:5432/postgres?sslmode=disable';

const recorder = (): { statements: string[]; connect: (url: string) => SqlRunner } => {
  const statements: string[] = [];
  return {
    statements,
    connect: () => ({
      exec: async (sql: string) => {
        statements.push(sql);
      },
      close: async () => undefined,
    }),
  };
};

describe('unit · template-db', () => {
  test('each worker id owns a different database', () => {
    const names = [0, 1, 2, 3].map((worker) => databaseNameFor(DEFAULT_TEMPLATE, worker));
    expect(new Set(names).size).toBe(4);
    expect(names[2]).toBe(`${DEFAULT_TEMPLATE}_w2`);
  });

  test('the worker id comes from the test runner environment', () => {
    expect(workerId({ BUN_TEST_WORKER_ID: '3' })).toBe(3);
    expect(workerId({ ULTIMATE_TEST_WORKER: '7' })).toBe(7);
    expect(workerId({}, 0)).toBe(0);
    expect(workerId({}, 4097)).toBe(1);
  });

  test('a runner-assigned shard beats the index Bun assigns its own --parallel worker', () => {
    // Measured on Bun 1.3.14: `bun test --parallel` sets BOTH of these, identically and 1-based.
    // The `x test` shard index has to win, or two shards share one cloned database.
    expect(
      workerId({ ULTIMATE_TEST_WORKER: '0', BUN_TEST_WORKER_ID: '2', JEST_WORKER_ID: '2' }),
    ).toBe(0);
    // And with no shard assigned, Bun's own workers stay distinct from each other.
    const parallel = [1, 2, 3].map((id) =>
      databaseNameFor(DEFAULT_TEMPLATE, workerId({ BUN_TEST_WORKER_ID: String(id) })),
    );
    expect(new Set(parallel).size).toBe(3);
  });

  test('two workers acquire distinct databases from the same template', async () => {
    const first = recorder();
    const second = recorder();
    const a = await acquireWorkerDatabase(
      { adminUrl: ADMIN },
      { connect: first.connect, env: { BUN_TEST_WORKER_ID: '0' } },
    );
    const b = await acquireWorkerDatabase(
      { adminUrl: ADMIN },
      { connect: second.connect, env: { BUN_TEST_WORKER_ID: '1' } },
    );
    expect(a.database).not.toBe(b.database);
    expect(a.url).not.toBe(b.url);
    expect(a.kind).toBe('postgres');
    expect(first.statements).toContain(cloneSql(DEFAULT_TEMPLATE, a.database));
    expect(second.statements).toContain(cloneSql(DEFAULT_TEMPLATE, b.database));
  });

  test('the template is created and migrated once, under an advisory lock', async () => {
    const { statements, connect } = recorder();
    const migrated: string[] = [];
    await acquireWorkerDatabase(
      {
        adminUrl: ADMIN,
        migrate: async (url) => {
          migrated.push(url);
        },
      },
      { connect, env: { BUN_TEST_WORKER_ID: '0' } },
    );
    expect(statements[0]).toBe(lockSql(DEFAULT_TEMPLATE));
    expect(statements).toContain(createTemplateSql(DEFAULT_TEMPLATE));
    expect(migrated).toEqual([urlFor(ADMIN, DEFAULT_TEMPLATE)]);
    expect(statements.some((sql) => sql.startsWith('SELECT pg_advisory_unlock'))).toBe(true);
  });

  // On any Postgres that outlives one run — a laptop, a self-hosted runner — the template is
  // created once and found again on every later run. Tolerating "already exists" for the CREATE
  // must not also skip the migrations, or every worker database is a clone of the first run's
  // schema and every live test asserts against a stale one.
  test('an existing template is still migrated', async () => {
    const statements: string[] = [];
    const migrated: string[] = [];
    const connect = (): SqlRunner => ({
      exec: async (sql: string) => {
        statements.push(sql);
        if (sql === createTemplateSql(DEFAULT_TEMPLATE)) {
          throw new Error(`database "${DEFAULT_TEMPLATE}" already exists`);
        }
      },
      close: async () => undefined,
    });

    const db = await acquireWorkerDatabase(
      {
        adminUrl: ADMIN,
        migrate: async (url) => {
          migrated.push(url);
        },
      },
      { connect, env: { BUN_TEST_WORKER_ID: '0' } },
    );

    expect(migrated).toEqual([urlFor(ADMIN, DEFAULT_TEMPLATE)]);
    expect(statements).toContain(cloneSql(DEFAULT_TEMPLATE, db.database));
  });

  // Migrations are idempotent and the advisory lock serialises them, so a migration that fails is
  // a real failure. Swallowing it clones a half-migrated template and every test after it asserts
  // against a schema nobody declared.
  test('a failing migration is reported, not swallowed into a half-migrated clone', async () => {
    const statements: string[] = [];
    const connect = (): SqlRunner => ({
      exec: async (sql: string) => {
        statements.push(sql);
      },
      close: async () => undefined,
    });

    const failing = acquireWorkerDatabase(
      {
        adminUrl: ADMIN,
        // The message is the trap: a substring match on "already exists" reads a migration failure
        // as "another worker got here first".
        migrate: async () => {
          throw new Error('relation "x_jobs" already exists');
        },
      },
      { connect, env: { BUN_TEST_WORKER_ID: '0' } },
    );

    await expect(failing).rejects.toBeUltimateError('X_TEST_DB_UNAVAILABLE');
    expect(statements).toContain(unlockSql(DEFAULT_TEMPLATE));
    expect(
      statements.some((sql) => sql.startsWith('CREATE DATABASE "ultimate_test_template_w')),
    ).toBe(false);
  });

  test('a worker database is dropped before it is recreated, so a crashed run cannot leak', async () => {
    const { statements, connect } = recorder();
    const db = await acquireWorkerDatabase(
      { adminUrl: ADMIN },
      { connect, env: { BUN_TEST_WORKER_ID: '2' } },
    );
    // The drop has to be PRESENT for the comparison below to mean anything: a drop that is never
    // issued answers -1 from `indexOf`, and -1 is less than every real index, so the ordering read
    // as satisfied for a run that cloned straight over a crashed worker's leftover database.
    expect(statements).toContain(dropSql(db.database));
    expect(statements.indexOf(dropSql(db.database))).toBeLessThan(
      statements.indexOf(cloneSql(DEFAULT_TEMPLATE, db.database)),
    );
  });

  test('teardown drops only this worker database', async () => {
    const { statements, connect } = recorder();
    const db = await acquireWorkerDatabase(
      { adminUrl: ADMIN },
      { connect, env: { BUN_TEST_WORKER_ID: '5' } },
    );
    await db.drop();
    expect(statements.at(-1)).toBe(dropSql(`${DEFAULT_TEMPLATE}_w5`));
  });

  test('urlFor swaps the database and keeps credentials and parameters', () => {
    expect(urlFor(ADMIN, 'ultimate_test_template_w1')).toBe(
      'postgres://user:pw@localhost:5432/ultimate_test_template_w1?sslmode=disable',
    );
  });

  test('with no Postgres configured it falls back to PGlite instead of failing', async () => {
    const db = await acquireWorkerDatabase({}, { connect: recorder().connect, env: {} });
    expect(db.kind).toBe('pglite');
    expect(db.url).toContain('pglite://memory/');
  });

  test('a failing admin connection reports X_TEST_DB_UNAVAILABLE with a fix', async () => {
    const connect = (): SqlRunner => ({
      exec: async () => {
        throw new Error('connection refused');
      },
      close: async () => undefined,
    });
    try {
      await acquireWorkerDatabase({ adminUrl: ADMIN }, { connect, env: {} });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_DB_UNAVAILABLE');
      expect((error as { fix: string }).fix).toContain('TEST_DATABASE_URL');
    }
  });

  test('a driver that rejects with an unrenderable value still reports X_TEST_DB_UNAVAILABLE', async () => {
    // `String(Object.create(null))` THROWS: no `toString`, no `Symbol.toPrimitive`. The local
    // `String(error)` helper this replaced raised a TypeError while FORMATTING the refusal, so
    // the caller caught a TypeError where a named, fixable failure belongs — and `bun run
    // error-render` cannot see a value laundered through a helper.
    const hostile = Object.create(null) as Record<string, never>;
    const connect = (): SqlRunner => ({
      exec: async (sql: string) => {
        if (sql.includes('TEMPLATE "')) throw hostile;
      },
      close: async () => undefined,
    });
    try {
      await acquireWorkerDatabase(
        { adminUrl: ADMIN },
        { connect, env: { BUN_TEST_WORKER_ID: '0' } },
      );
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_DB_UNAVAILABLE');
    }
  });
});
