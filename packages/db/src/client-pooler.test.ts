// Single responsibility: which roles a transaction pooler may carry, decided before any socket. A
// session advisory lock through one excludes nobody, so the refusal cannot wait for a statement:
// by then a second migrator has already read `got: true`.

import { afterEach, describe, expect, test } from 'bun:test';
import { postgresClient } from './client';
import { POOLER_ENV } from './pooler';

const URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;
const restorePooler = process.env[POOLER_ENV];

afterEach(() => {
  host.Bun.SQL = realBunSql;
  if (restorePooler === undefined) delete process.env[POOLER_ENV];
  else process.env[POOLER_ENV] = restorePooler;
});

/** Records every url a pool was opened on: a refusal "before any socket" means this stays empty. */
function recordPools(): { readonly urls: string[] } {
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
}

describe('postgresClient under a pooler', () => {
  test.each(['migrate', 'replicator'] as const)(
    '%s under transaction refuses, opening no pool',
    (role) => {
      const pools = recordPools();

      expect(() =>
        postgresClient({ url: URL, role, env: { DATABASE_POOLER: 'transaction' } }),
      ).toThrow('X_DB_POOLER_SESSION_REQUIRED');
      expect(pools.urls).toEqual([]);
    },
  );

  test.each(['migrate', 'replicator'] as const)('%s under session passes', async (role) => {
    const pools = recordPools();
    const client = postgresClient({ url: URL, role, env: { DATABASE_POOLER: 'session' } });

    await client.ping();

    expect(pools.urls).toHaveLength(1);
  });

  test.each(['web', 'sync', 'worker', 'scheduler'] as const)(
    '%s under transaction passes',
    async (role) => {
      const pools = recordPools();
      const client = postgresClient({ url: URL, role, env: { DATABASE_POOLER: 'transaction' } });

      await client.ping();

      expect(pools.urls[0]).not.toContain('statement_timeout');
      expect(client.pooler).toBe('transaction');
    },
  );

  test('a caller that named no pooler is under the environment, so none can forget it', async () => {
    process.env[POOLER_ENV] = 'transaction';
    const pools = recordPools();

    expect(() => postgresClient({ url: URL, role: 'migrate' })).toThrow(
      'X_DB_POOLER_SESSION_REQUIRED',
    );
    await postgresClient({ url: URL, role: 'web' }).ping();

    expect(pools.urls[0]).not.toContain('statement_timeout');
  });

  test('an env handed in is the whole answer: none there is none, whatever the process says', async () => {
    process.env[POOLER_ENV] = 'transaction';
    const pools = recordPools();
    const client = postgresClient({ url: URL, role: 'web', env: {} });

    await client.ping();

    expect(client.pooler).toBeUndefined();
    expect(pools.urls[0]).toContain('statement_timeout');
  });

  test('an env handed in also names the role and, with no url, the database', async () => {
    const pools = recordPools();
    const client = postgresClient({
      env: { ROLE: 'migrate', DATABASE_URL: URL, DATABASE_POOLER: 'session' },
    });

    await client.ping();

    expect(client.profile.max).toBe(1);
    expect(pools.urls[0]).toStartWith(URL);
  });

  test('with neither, the client reports no pooler and sends the bounds', async () => {
    delete process.env[POOLER_ENV];
    const pools = recordPools();
    const client = postgresClient({ url: URL, role: 'web' });

    await client.ping();

    expect(client.pooler).toBeUndefined();
    expect(pools.urls[0]).toContain('statement_timeout');
  });
});
