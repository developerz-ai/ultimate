// Single responsibility: `withTransaction(fn, { retry })` against a real serialization failure.
// A recording client can prove the loop counts; only Postgres can prove the thing it counts is a
// `40001` the framework recognised, which is the whole of D2 — `serializable` was unusable because
// nothing distinguished a lost race from a dead socket. Skips unless `TEST_DATABASE_URL` is set.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · serializable retry', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '', role: 'web' });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    const setup = freshClient();
    await setup.execute(raw('drop table if exists x_live_ledger'));
    await setup.execute(raw('create table x_live_ledger (id serial primary key, amount int)'));
    await setup.execute(raw('insert into x_live_ledger (amount) values (1), (1)'));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('a real 40001 is retried, and the second attempt commits', async () => {
    // Both transactions read the whole table and then write to it, which is the textbook
    // read-write skew SERIALIZABLE refuses. The one that commits second loses — deterministically,
    // because the barrier makes `slow` commit last.
    let released: (() => void) | undefined;
    const otherCommitted = new Promise<void>((resolve) => {
      released = resolve;
    });
    const attempts: number[] = [];

    const slow = withTransaction(
      async (tx) => {
        attempts.push(attempts.length + 1);
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        // Only the first attempt waits: the second runs after the winner is durable, so it sees a
        // settled snapshot and commits.
        if (attempts.length === 1) await otherCommitted;
        await tx.execute(sql`insert into x_live_ledger (amount) values (10)`);
      },
      { isolation: 'serializable', retry: 3, client: freshClient() },
    );

    await withTransaction(
      async (tx) => {
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        await tx.execute(sql`insert into x_live_ledger (amount) values (20)`);
      },
      { isolation: 'serializable', client: freshClient() },
    );
    released?.();

    await slow;

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    const rows = await freshClient().query<{ amount: number }>(
      sql`select amount from x_live_ledger order by amount`,
    );
    // Both writes landed exactly once: the retry re-ran the body, it did not duplicate it.
    expect(rows.map((row) => row.amount)).toEqual([1, 1, 10, 20]);
  }, 20_000);

  test('retry: 0 surfaces the 40001 as X_DB_SERIALIZATION_FAILURE, never as unreachable', async () => {
    let released: (() => void) | undefined;
    const otherCommitted = new Promise<void>((resolve) => {
      released = resolve;
    });

    const loser = withTransaction(
      async (tx) => {
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        await otherCommitted;
        await tx.execute(sql`insert into x_live_ledger (amount) values (10)`);
      },
      { isolation: 'serializable', client: freshClient() },
    ).then(
      () => undefined,
      (error: unknown) => error as { code: string; fix: string },
    );

    await withTransaction(
      async (tx) => {
        await tx.query(sql`select sum(amount) from x_live_ledger`);
        await tx.execute(sql`insert into x_live_ledger (amount) values (20)`);
      },
      { isolation: 'serializable', client: freshClient() },
    );
    released?.();

    const caught = await loser;
    expect(caught?.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(caught?.fix).toContain('withTransaction(fn, { retry: 3 })');
  }, 20_000);
});
