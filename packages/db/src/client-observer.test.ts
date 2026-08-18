// Split out of `client.test.ts` for the file-size ceiling, along the seam `observe.ts` already
// draws — the same split `pglite-observer.test.ts` is on the other driver. What it pins: the one
// funnel every statement takes, pooled or pinned, and the attribution and expected-loop reason
// stamped onto the event it reports.

import { afterEach, describe, expect, test } from 'bun:test';
import { withStatementAttribution } from './attribution';
import { createPostgresClient } from './client';
import { DbError } from './errors';
import { expectedQueryLoop } from './expected-loop';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver } from './observe';
import { sql } from './sql';

/**
 * Stands in for what `Bun.SQL` itself throws — an error carrying no Ultimate code, which is
 * precisely the shape that must never escape this module.
 */
class DriverFailure extends Error {
  override readonly name = 'DriverFailure';
}

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // Process-wide, so a test that installs one and leaves it behind observes every later test.
  setStatementObserver(undefined);
});

interface FakeSqlOptions {
  readonly statementError?: DriverFailure | undefined;
  /** What every statement resolves with — the row count the observer reports comes off this. */
  readonly rows?: readonly unknown[] | undefined;
}

/** No recording of its own: what the statements were is the observer's answer, not the pool's. */
function installFakeSql(options: FakeSqlOptions = {}): void {
  const rows = options.rows ?? [];
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return rows;
    }
    async reserve(): Promise<unknown> {
      return {
        unsafe: async (): Promise<unknown> => {
          if (options.statementError !== undefined) throw options.statementError;
          return rows;
        },
        release: (): void => undefined,
      };
    }
    async close(): Promise<void> {}
  };
}

/** The rejected value, or the resolved one — the assertion then says which of the two we got. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error);

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
