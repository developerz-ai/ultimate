// Single responsibility: isolated tests for the pooled `Bun.SQL` client — how a connection is
// pinned, and how every failure around that pin is typed. Reserving is the one step that runs
// outside the statement path, so an unmapped failure there is exactly what reaches an MCP caller
// as an untyped driver error instead of X_DB_UNAVAILABLE.

import { afterEach, describe, expect, test } from 'bun:test';
import { withStatementAttribution } from './attribution';
import { createPostgresClient } from './client';
import { DbError } from './errors';
import { expectedQueryLoop } from './expected-loop';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver } from './observe';
import { sql } from './sql';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

/**
 * Stands in for what `Bun.SQL` itself throws — an error carrying no Ultimate code, which is
 * precisely the shape that must never escape this module.
 */
class DriverFailure extends Error {
  override readonly name = 'DriverFailure';
}

interface FakePool {
  /** Connection urls the factory was constructed with. */
  readonly urls: string[];
  /** Statement texts, pooled and pinned alike, in the order the driver saw them. */
  readonly statements: string[];
  /** Only the ones that reached a pinned connection — which path a statement took is the point. */
  readonly pinned: string[];
  releases: number;
  closes: number;
}

interface FakeSqlOptions {
  readonly reserveError?: DriverFailure | undefined;
  readonly statementError?: DriverFailure | undefined;
  readonly closeError?: DriverFailure | undefined;
  /** What every statement resolves with — the row count the observer reports comes off this. */
  readonly rows?: readonly unknown[] | undefined;
}

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // Process-wide, so a test that installs one and leaves it behind observes every later test.
  setStatementObserver(undefined);
});

function installFakeSql(options: FakeSqlOptions = {}): FakePool {
  const pool: FakePool = { urls: [], statements: [], pinned: [], releases: 0, closes: 0 };
  const rows = options.rows ?? [];
  host.Bun.SQL = class {
    constructor(url: string) {
      pool.urls.push(url);
    }
    async unsafe(text: string): Promise<unknown> {
      pool.statements.push(text);
      return rows;
    }
    async reserve(): Promise<unknown> {
      if (options.reserveError !== undefined) throw options.reserveError;
      return {
        unsafe: async (text: string): Promise<unknown> => {
          pool.statements.push(text);
          pool.pinned.push(text);
          if (options.statementError !== undefined) throw options.statementError;
          return rows;
        },
        release: (): void => {
          pool.releases += 1;
        },
      };
    }
    async close(): Promise<void> {
      pool.closes += 1;
      if (options.closeError !== undefined) throw options.closeError;
    }
  };
  return pool;
}

/** The rejected value, or the resolved one — the assertion then says which of the two we got. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error);

describe('createPostgresClient', () => {
  test('the pool url carries the role statement timeout and the application name', async () => {
    const pool = installFakeSql();
    const client = createPostgresClient({
      url: TEST_URL,
      role: 'worker',
      applicationName: 'ultimate-worker',
    });
    await client.query(sql`select 1`);

    expect(client.profile).toEqual({ max: 8, statementTimeoutMs: 120_000, idleTimeoutMs: 30_000 });
    const url = new URL(pool.urls[0] ?? '');
    expect(url.searchParams.get('options')).toBe('-c statement_timeout=120000');
    expect(url.searchParams.get('application_name')).toBe('ultimate-worker');
  });
});

describe('reserve', () => {
  test('a pin runs its statements on the reserved handle and releases it once', async () => {
    const pool = installFakeSql();
    const connection = await createPostgresClient({ url: TEST_URL }).reserve();

    await connection.execute(sql`BEGIN READ ONLY`);
    await connection.query(sql`select ${1}`);
    connection.release();

    expect(pool.statements).toEqual(['BEGIN READ ONLY', 'select $1']);
    expect(pool.releases).toBe(1);
  });

  test('a pool that cannot hand out a connection fails with X_DB_UNAVAILABLE', async () => {
    const source = new DriverFailure('sorry, too many clients already');
    installFakeSql({ reserveError: source });
    const client = createPostgresClient({ url: TEST_URL });

    const caught = await rejection(client.reserve());

    expect(caught).toBeInstanceOf(DbError);
    const error = caught as DbError;
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect(error.cause).toContain('reserve a connection');
    // The driver's own error is kept, never swallowed — the typing is the only thing added.
    expect(error.sourceError).toBe(source);
  });

  test('a statement that fails on the pinned connection is typed the same way', async () => {
    installFakeSql({ statementError: new DriverFailure('deadlock detected') });
    const connection = await createPostgresClient({ url: TEST_URL }).reserve();

    const caught = await rejection(connection.query(sql`select 1`));

    expect(caught).toBeInstanceOf(DbError);
    expect((caught as DbError).code).toBe('X_DB_UNAVAILABLE');
  });

  // `withTransaction` releases in a `finally` and disposal fires on that same scope, so two
  // owners reach this line. The second one would be handing back a connection the pool has
  // already given to somebody else — freeing a pin that is not ours to free.
  test('release is idempotent, and disposal is the same call', async () => {
    const pool = installFakeSql();
    const connection = await createPostgresClient({ url: TEST_URL }).reserve();

    connection.release();
    connection.release();
    connection[Symbol.dispose]();

    expect(pool.releases).toBe(1);
  });

  // The mirror of the PGlite rule: a caller that kept its `tx` past the callback holds a handle
  // with no claim on the connection. Writing straight to it lands the statement inside whatever
  // unit of work the pool handed that connection to next — a stray row in someone else's
  // transaction, committed or rolled back with it, and no error anywhere to explain it.
  test('a released reservation runs on the pool, never on the pin it gave back', async () => {
    const pool = installFakeSql();
    const leaked = await createPostgresClient({ url: TEST_URL }).reserve();
    await leaked.execute(sql`BEGIN`);
    leaked.release();

    await leaked.execute(sql`insert into t values (1)`);
    await leaked.query(sql`select 2`);
    expect(await leaked.one(sql`select 3`)).toBeNull();

    expect(pool.pinned).toEqual(['BEGIN']);
    expect(pool.statements).toEqual(['BEGIN', 'insert into t values (1)', 'select 2', 'select 3']);
  });

  test('`using` gives the pin back on the way out of the block', async () => {
    const pool = installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    {
      using connection = await client.reserve();
      await connection.execute(sql`BEGIN`);
      expect(pool.releases).toBe(0);
    }

    expect(pool.releases).toBe(1);
    expect(pool.pinned).toEqual(['BEGIN']);
  });

  test('`using` releases even when the body throws', async () => {
    const pool = installFakeSql({ statementError: new DriverFailure('deadlock detected') });
    const client = createPostgresClient({ url: TEST_URL });

    const caught = await rejection(
      (async () => {
        using connection = await client.reserve();
        await connection.execute(sql`BEGIN`);
      })(),
    );

    expect((caught as DbError).code).toBe('X_DB_UNAVAILABLE');
    expect(pool.releases).toBe(1);
  });
});

describe('close', () => {
  test('closes the pool it opened, and reopens on the next statement', async () => {
    const pool = installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    await client.query(sql`select 1`);
    await client.close();
    await client.query(sql`select 2`);

    expect(pool.closes).toBe(1);
    expect(pool.urls).toHaveLength(2);
  });

  test('a client that never connected has no pool to close', async () => {
    const pool = installFakeSql();

    await createPostgresClient({ url: TEST_URL }).close();

    expect(pool.closes).toBe(0);
    expect(pool.urls).toEqual([]);
  });

  // The corpse: a `close()` that rejects has still torn the pool down, and keeping the handle
  // cached hands it straight back to the next `connect()`. Every statement after that fails on a
  // pool nobody can see is dead, and no second `close()` can clear it — the same throw recurs.
  test('a rejecting close still clears the pool, so the next statement opens a live one', async () => {
    const failure = new DriverFailure('connection terminated unexpectedly');
    const pool = installFakeSql({ closeError: failure });
    const client = createPostgresClient({ url: TEST_URL });
    await client.query(sql`select 1`);

    expect(await rejection(client.close())).toBe(failure);

    await client.query(sql`select 2`);
    expect(pool.urls).toHaveLength(2);
    // The second statement went to the new pool, not the one that failed to close.
    expect(pool.statements).toEqual(['select 1', 'select 2']);
  });

  test('closing twice after a rejection closes the second pool, not the dead one', async () => {
    const pool = installFakeSql({ closeError: new DriverFailure('connection terminated') });
    const client = createPostgresClient({ url: TEST_URL });
    await client.query(sql`select 1`);

    await rejection(client.close());
    await client.close();

    // The second close found nothing cached, so it closed nothing — not the corpse a second time.
    expect(pool.closes).toBe(1);
  });
});

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

describe('the statement observer', () => {
  // `runOn` is the funnel, so pooled and pinned statements are the same event — a detector that
  // only saw the pool would be blind to everything inside a transaction, which is where the read
  // loops live.
  test('sees every statement once, pooled and pinned alike', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql({ rows: [{ id: 1 }, { id: 2 }] });
    const client = createPostgresClient({ url: TEST_URL });

    await client.query(sql`select id from members where org = ${'o_1'}`);
    using connection = await client.reserve();
    await connection.execute(sql`BEGIN`);

    expect(observer.seen.map((event) => event.text)).toEqual([
      'select id from members where org = $1',
      'BEGIN',
    ]);
    expect(observer.seen[0]?.values).toEqual(['o_1']);
    expect(observer.seen[0]?.rows).toBe(2);
    expect(observer.seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(observer.seen[0]).not.toHaveProperty('error');
  });

  test('reports a failed statement with the error the caller is about to be thrown', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql({ statementError: new DriverFailure('deadlock detected') });
    const connection = await createPostgresClient({ url: TEST_URL }).reserve();

    const caught = await rejection(connection.query(sql`select 1`));

    expect((caught as DbError).code).toBe('X_DB_UNAVAILABLE');
    // Identity, not shape: the event carries the very error thrown, already wrapped by the funnel.
    expect(observer.seen[0]?.error).toBe(caught);
    expect(observer.seen[0]?.rows).toBe(0);
    connection.release();
  });

  // Strict test mode is an observer that throws, and the throw must arrive as itself. Notifying
  // inside the statement's own `try` would re-report a statement that succeeded as X_DB_UNAVAILABLE.
  test('a throwing observer reaches the caller as its own error, not a database failure', async () => {
    installFakeSql();
    setStatementObserver({
      onStatement(): void {
        throw new Error('n+1 in a strict test');
      },
    });

    const caught = await rejection(createPostgresClient({ url: TEST_URL }).query(sql`select 1`));

    expect(caught).not.toBeInstanceOf(DbError);
    expect((caught as Error).message).toBe('n+1 in a strict test');
  });

  test('reserving a connection and closing the pool are not statements', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    (await client.reserve()).release();
    await client.close();

    expect(observer.seen).toEqual([]);
  });

  test('an uninstalled seam observes nothing, which is the production path', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    setStatementObserver(undefined);
    installFakeSql();

    await createPostgresClient({ url: TEST_URL }).query(sql`select 1`);

    expect(observer.seen).toEqual([]);
  });

  test('carries the attribution declared by the scope, undefined outside every scope', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    await withStatementAttribution('members', 'findById', () => client.query(sql`select 1`));
    await client.query(sql`select 2`);

    expect(observer.seen.map((event) => event.attribution)).toEqual([
      { entity: 'members', op: 'findById' },
      undefined,
    ]);
  });

  test('the failing statement path still carries the attribution', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql({ statementError: new DriverFailure('deadlock detected') });
    const connection = await createPostgresClient({ url: TEST_URL }).reserve();

    const caught = await rejection(
      withStatementAttribution('members', 'findById', () => connection.query(sql`select 1`)),
    );

    expect((caught as DbError).code).toBe('X_DB_UNAVAILABLE');
    expect(observer.seen[0]?.attribution).toEqual({ entity: 'members', op: 'findById' });
    expect(observer.seen[0]?.rows).toBe(0);
    connection.release();
  });

  // Two independent scopes: an expected-loop reason does not crowd out the attribution.
  test('attribution and an expected-loop reason are stamped together, independently', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    await withStatementAttribution('members', 'findMany', () =>
      expectedQueryLoop('one lookup per id', () => client.query(sql`select 1`)),
    );

    expect(observer.seen[0]?.attribution).toEqual({ entity: 'members', op: 'findMany' });
    expect(observer.seen[0]?.expected).toBe('one lookup per id');
  });
});
