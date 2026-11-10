// What the boot does with `DATABASE_POOLER`: the served roles' client is `startDb`'s, never
// `defaultClient()`'s, so a switch that stopped there would reach no booted process. And the step
// that applies migrations is refused for whatever ROLE the shell happens to have.

import { afterEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import type { DbClient, PostgresClient } from '@ultimat3/db';
import { dbUnavailable, POOL_PROFILES, setDbClient } from '@ultimat3/db';
import type { DevServices } from './runtime-bindings';
import { startDb, startQueue } from './runtime-queue';
import { reportStatementBound } from './runtime-statement-bound';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

const external = {
  root: '/app',
  db: { mode: 'external', url: 'postgres://app@127.0.0.1:5432/app' },
} as unknown as DevServices;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  setDbClient(undefined);
});

const recordPools = (): { readonly urls: string[] } => {
  const seen = { urls: [] as string[] };
  host.Bun.SQL = class {
    constructor(url: string) {
      seen.urls.push(url);
    }
    async unsafe(): Promise<unknown> {
      return [];
    }
    async close(): Promise<void> {}
  };
  return seen;
};

describe('startDb', () => {
  test('hands the boot its own DATABASE_POOLER', async () => {
    const pools = recordPools();
    const { client } = startDb(external, { DATABASE_POOLER: 'transaction' });

    await client.ping();

    expect(pools.urls[0]).not.toContain('statement_timeout');
  });

  test('and the replica the same answer', async () => {
    const pools = recordPools();
    const { replica } = startDb(external, {
      DATABASE_POOLER: 'transaction',
      DATABASE_REPLICA_URL: 'postgres://reader@replica:5432/app',
    });

    await replica?.ping();

    expect(pools.urls).toHaveLength(1);
    expect(pools.urls[0]).toContain('replica');
    expect(pools.urls[0]).not.toContain('statement_timeout');
  });

  test('unset sends the bounds', async () => {
    const pools = recordPools();
    const { client } = startDb(external, {});

    await client.ping();

    expect(pools.urls[0]).toContain('statement_timeout');
  });

  test('a typo refuses the boot', () => {
    expect(() => startDb(external, { DATABASE_POOLER: 'txn' })).toThrow('X_ENV_MISSING');
  });
});

describe('startQueue, the step that applies', () => {
  test('refuses under transaction whatever ROLE the shell has, opening no pool', async () => {
    const pools = recordPools();

    await expect(
      startQueue(external, undefined, { DATABASE_POOLER: 'transaction' }, 'apply'),
    ).rejects.toThrow('X_DB_POOLER_SESSION_REQUIRED');
    expect(pools.urls).toEqual([]);
  });
});

describe('reportStatementBound', () => {
  const logged: Record<string, unknown>[] = [];
  const capture = (): void => {
    logged.length = 0;
    const releaseLogSink = installLogSink((line, level) => {
      logged.push({ ...(JSON.parse(line) as Record<string, unknown>), level });
    });
    restoreSink = () => releaseLogSink();
  };
  let restoreSink = (): unknown => undefined;
  afterEach(() => {
    restoreSink();
  });

  const pool = (rows: readonly object[], pooler?: 'transaction'): PostgresClient =>
    ({
      profile: POOL_PROFILES.web,
      pooler,
      query: async () => rows,
    }) as unknown as PostgresClient;

  const IN_FORCE = [
    { name: 'statement_timeout', setting: '10000' },
    { name: 'idle_in_transaction_session_timeout', setting: '30000' },
  ];
  const GONE = [
    { name: 'statement_timeout', setting: '0' },
    { name: 'idle_in_transaction_session_timeout', setting: '0' },
  ];

  test('a bound in force logs nothing', async () => {
    capture();
    await reportStatementBound(pool(IN_FORCE));

    expect(logged).toEqual([]);
  });

  test('a dropped bound with no switch logs one error line, and the boot goes on', async () => {
    capture();
    await reportStatementBound(pool(GONE));

    expect(logged).toHaveLength(1);
    expect(logged[0]?.['level']).toBe('error');
    expect(logged[0]?.['code']).toBe('X_DB_STATEMENT_BOUND_LOST');
  });

  test('a client with no profile, PGlite, is not asked', async () => {
    capture();
    let asked = false;
    const embedded: DbClient = {
      query: async () => {
        asked = true;
        return [];
      },
      one: async () => null,
      execute: async () => 0,
    };
    await reportStatementBound(embedded);

    expect(asked).toBe(false);
  });

  test('a reading that fails does not stop the boot', async () => {
    capture();
    const broken = {
      profile: POOL_PROFILES.web,
      pooler: undefined,
      query: async () => {
        throw dbUnavailable('the socket went away');
      },
    } as unknown as PostgresClient;

    await reportStatementBound(broken);

    expect(logged.filter((line) => line['level'] === 'error')).toEqual([]);
  });
});
