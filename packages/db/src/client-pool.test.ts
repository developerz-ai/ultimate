// Single responsibility: the pool's two operator-facing knobs — how many connections a process
// opens, and how long it will wait for one. Both were unreachable from outside the image until
// 1.2.0: `POOL_PROFILES` was frozen into the build, and `reserve()` queued with no deadline, so
// exhaustion arrived as a hang rather than as a 503.

import { afterEach, describe, expect, test } from 'bun:test';
import { baseClient, createPostgresClient, type PostgresClient, setDbClient } from './client';
import type { DbError } from './errors';
import { POOL_MAX_ENV, poolProfileFor } from './pool-profile';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;
const restoreMax = process.env[POOL_MAX_ENV];

afterEach(() => {
  host.Bun.SQL = realBunSql;
  if (restoreMax === undefined) delete process.env[POOL_MAX_ENV];
  else process.env[POOL_MAX_ENV] = restoreMax;
  // Process-wide: `baseClient()` caches, so a client built here would answer for every later test.
  setDbClient(undefined);
});

/** A pool that hands out one working pin and counts the releases. */
function installFakeSql(): { releases: number } {
  const counter = { releases: 0 };
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return [];
    }
    async reserve(): Promise<unknown> {
      return {
        unsafe: async (): Promise<unknown> => [],
        release: (): void => {
          counter.releases += 1;
        },
      };
    }
    async close(): Promise<void> {}
  };
  return counter;
}

describe('the role profiles', () => {
  test('lock_timeout is the migrate role, and only the migrate role', () => {
    // An `alter table` queues behind a long SELECT and every later query on that table queues
    // behind it. `migrate` runs `statement_timeout = 0`, so nothing else would end the wait.
    expect(poolProfileFor('migrate').lockTimeoutMs).toBe(3_000);
    for (const role of ['web', 'sync', 'worker', 'scheduler', 'replicator'] as const) {
      expect(poolProfileFor(role).lockTimeoutMs).toBe(0);
    }
  });

  test('a request-serving role bounds how long reserve() may wait; a run-once one does not', () => {
    expect(poolProfileFor('web').acquireTimeoutMs).toBeGreaterThan(0);
    expect(poolProfileFor('sync').acquireTimeoutMs).toBeGreaterThan(0);
    // `migrate` is `max: 1` and the advisory-lock pin holds it for the whole run: a deadline here
    // would refuse the migration its own session. `MIGRATION_LOCK_WAIT_MS` bounds that wait.
    expect(poolProfileFor('migrate').acquireTimeoutMs).toBe(0);
  });
});

describe('DATABASE_POOL_MAX', () => {
  test('an operator value overrides the frozen role default', () => {
    installFakeSql();
    process.env[POOL_MAX_ENV] = '3';
    setDbClient(undefined);

    // The finding: 400 web pods × the frozen `max: 20` is 8,000 backends against a
    // `max_connections` of 450, and the only way to change it was to ship a new image.
    expect((baseClient() as PostgresClient).profile.max).toBe(3);
  });

  test('an unparseable value refuses instead of silently keeping the default', () => {
    installFakeSql();
    process.env[POOL_MAX_ENV] = '0';
    setDbClient(undefined);

    // A fleet that ignored the number it was given is the failure the variable exists to prevent,
    // and it would only ever be found in `pg_stat_activity` at 3am.
    expect(() => baseClient()).toThrow('X_ENV_MISSING');

    process.env[POOL_MAX_ENV] = 'twenty';
    setDbClient(undefined);
    expect(() => baseClient()).toThrow('X_ENV_MISSING');
  });

  test('unset leaves the role default untouched', () => {
    installFakeSql();
    delete process.env[POOL_MAX_ENV];
    setDbClient(undefined);

    expect((baseClient() as PostgresClient).profile.max).toBe(poolProfileFor().max);
  });
});

describe('acquireTimeoutMs', () => {
  test('reserve() refuses on its deadline instead of queueing forever', async () => {
    // Queueing turns exhaustion into a hang: `/readyz`'s `select 1` joins the same queue and the
    // kubelet kills a pod that could have answered 503.
    let settle: ((value: unknown) => void) | undefined;
    let released = 0;
    host.Bun.SQL = class {
      async unsafe(): Promise<unknown> {
        return [];
      }
      reserve(): Promise<unknown> {
        return new Promise((resolve) => {
          settle = resolve;
        });
      }
      async close(): Promise<void> {}
    };
    const client = createPostgresClient({
      url: TEST_URL,
      profile: { acquireTimeoutMs: 20, max: 4 },
    });

    const caught = (await client.reserve().catch((error: unknown) => error)) as DbError;

    expect(caught.code).toBe('X_DB_POOL_EXHAUSTED');
    expect(caught.cause).toContain('20ms');
    expect(caught.cause).toContain('4');

    // The late pin is given back, never dropped: the pool hands one out whenever one frees, and a
    // pin nobody holds is a connection nobody gets back.
    settle?.({
      unsafe: async () => [],
      release: () => {
        released += 1;
      },
    });
    await Bun.sleep(1);
    expect(released).toBe(1);
  });

  test('0 waits, which is what a run-once role wants', async () => {
    const counter = installFakeSql();
    const client = createPostgresClient({ url: TEST_URL, profile: { acquireTimeoutMs: 0 } });

    const connection = await client.reserve();
    connection.release();

    expect(counter.releases).toBe(1);
  });
});
