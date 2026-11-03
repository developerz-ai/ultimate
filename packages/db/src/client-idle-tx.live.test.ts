// Single responsibility: the idle-in-transaction bound against a real server. A handler awaiting a
// hung call inside a transaction holds a pooled slot and its row locks past the request's own 504;
// the bound is what ends it, and a bound that took the slot with it would be a new outage. `max: 1`
// so the answer after the close is the same slot. Skips unless `TEST_DATABASE_URL` is set.

import { afterEach, describe, expect, test } from 'bun:test';
import { type DbConnection, type PostgresClient, postgresClient } from './client';
import type { DbError } from './errors';
import { sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · an idle transaction', () => {
  const clients: PostgresClient[] = [];

  const open = (max: number, idleInTransactionMs: number): PostgresClient => {
    const client = postgresClient({
      url: url ?? '',
      role: 'web',
      profile: { max, idleInTransactionMs },
    });
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  /**
   * Waits on the server's own word that the backend is gone, never on a guess at how long: each
   * pass is `pg_sleep` on another backend, so the only clock in this test is the server's.
   */
  const backendGone = async (pid: number): Promise<void> => {
    const observer = open(1, 0);
    for (let pass = 0; pass < 500; pass += 1) {
      const row = await observer.one<{ readonly alive: boolean }>(
        sql`select exists (select 1 from pg_stat_activity where pid = ${pid}) as alive, pg_sleep(0.01)`,
      );
      if (row?.alive === false) return;
    }
    expect.unreachable(`backend ${String(pid)} outlived a 200ms idle bound`);
  };

  const pidOf = async (on: Pick<DbConnection, 'one'>): Promise<number> => {
    const row = await on.one<{ readonly pid: number }>(sql`select pg_backend_pid() as pid`);
    return row?.pid ?? expect.unreachable('pg_backend_pid answered no row');
  };

  test('the session carries the role bound, so the server is the one holding it', async () => {
    const row = await open(1, 700).one<{ readonly value: string }>(
      sql`select current_setting('idle_in_transaction_session_timeout') as value`,
    );

    expect(row?.value).toBe('700ms');
  });

  test('the next statement on the pin is told why, and the slot comes back', async () => {
    const client = open(1, 200);
    const refused = await withTransaction(
      async (tx) => {
        await backendGone(await pidOf(tx));
        return tx.query(sql`select 1`);
      },
      { client },
    ).catch((error: unknown) => error as DbError);

    expect((refused as DbError).code).toBe('X_DB_STATEMENT_FAILED');
    expect((refused as DbError).meta?.['sqlState']).toBe('25P03');
    expect((refused as DbError).fix).toContain('before opening the transaction');
    expect(await client.one<{ readonly up: number }>(sql`select 1 as up`)).toEqual({ up: 1 });
  });

  test('a body that reaches COMMIT on a closed transaction does not report a commit', async () => {
    const client = open(1, 200);
    const refused = await withTransaction(
      async (tx) => {
        await backendGone(await pidOf(tx));
      },
      { client },
    ).catch((error: unknown) => error as DbError);

    expect((refused as DbError).code).toBe('X_DB_STATEMENT_FAILED');
    expect((refused as DbError).meta?.['sqlState']).toBe('25P03');
    expect(await client.one<{ readonly up: number }>(sql`select 1 as up`)).toEqual({ up: 1 });
  });

  test('its row lock is released with it', async () => {
    const client = open(2, 200);
    const lockKey = 7_230_411;
    const pin = await client.reserve();
    await pin.execute(sql`begin`);
    await pin.query(sql`select pg_advisory_xact_lock(${lockKey})`);
    await backendGone(await pidOf(pin));
    pin.release();

    const free = await client.one<{ readonly got: boolean }>(
      sql`select pg_try_advisory_xact_lock(${lockKey}) as got`,
    );

    expect(free?.got).toBe(true);
  });
});
