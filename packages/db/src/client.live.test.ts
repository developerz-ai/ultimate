// Single responsibility: prove the pool's settings reach the *backend*, not just the DSN. The one
// test that existed read `url.searchParams.get('options')` back — and `.get()` decodes `+` to a
// space, so it passed on the working encoding and on a broken one alike. Only `current_setting`
// can tell them apart. Skips unless `TEST_DATABASE_URL` is set, like `migrate.live.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { DbError } from './errors';
import { sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · pool settings on the wire', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (profile: Partial<PostgresClient['profile']> = {}): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '', role: 'web', profile });
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('statement_timeout is actually set on the backend, not merely present in the DSN', async () => {
    // The failure this catches: a `web` pod believes statements are capped at 10s, a missing index
    // makes one endpoint a 90-second seq scan, all 20 slots fill, `/readyz` queues behind them and
    // the kubelet kills the pod. Post-mortem: `SHOW statement_timeout` returns `0`.
    const rows = await freshClient({ statementTimeoutMs: 2_500 }).query<{ value: string }>(
      sql`select current_setting('statement_timeout') as value`,
    );

    expect(rows[0]?.value).toBe('2500ms');
  });

  test('application_name arrives whole, so pg_stat_activity names the process', async () => {
    const client = createPostgresClient({
      url: url ?? '',
      role: 'web',
      applicationName: 'ultimate-web',
    });
    clients.push(client);

    const rows = await client.query<{ value: string }>(
      sql`select current_setting('application_name') as value`,
    );

    expect(rows[0]?.value).toBe('ultimate-web');
  });

  test('a statement past the timeout is X_DB_STATEMENT_TIMEOUT, never "cannot reach the database"', async () => {
    const client = freshClient({ statementTimeoutMs: 150 });

    const caught = (await client
      .query(sql`select pg_sleep(2)`)
      .catch((error: unknown) => error)) as DbError;

    expect(caught.code).toBe('X_DB_STATEMENT_TIMEOUT');
    expect(caught.fix).not.toContain('DATABASE_URL');
  });

  test('a unique violation is typed by its SQLSTATE, with the constraint in the fix', async () => {
    const client = freshClient();
    await client.execute(sql`drop table if exists x_live_unique`);
    await client.execute(sql`create table x_live_unique (email text primary key)`);
    await client.execute(sql`insert into x_live_unique values ('a@b.c')`);

    const caught = (await client
      .execute(sql`insert into x_live_unique values ('a@b.c')`)
      .catch((error: unknown) => error)) as DbError;

    expect(caught.code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(caught.fix).toContain('x_live_unique_pkey');
    await client.execute(sql`drop table x_live_unique`);
  });

  test('SET LOCAL lock_timeout turns a blocked ALTER into X_DB_LOCK_TIMEOUT', async () => {
    // A long SELECT holds ACCESS SHARE; the ALTER needs ACCESS EXCLUSIVE. Postgres' lock queue is
    // FIFO, so without a bound the migrator waits forever and every later query on that table
    // waits behind it.
    const owner = freshClient();
    const migrator = freshClient();
    await owner.execute(sql`drop table if exists x_live_lock`);
    await owner.execute(sql`create table x_live_lock (id int)`);

    using blocker = await owner.reserve();
    await blocker.execute(sql`BEGIN`);
    await blocker.execute(sql`lock table x_live_lock in access exclusive mode`);

    const caught = (await withTransaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = 200`);
        await tx.execute(sql`alter table x_live_lock add column added_at timestamptz`);
      },
      { client: migrator },
    ).catch((error: unknown) => error)) as DbError;

    expect(caught.code).toBe('X_DB_LOCK_TIMEOUT');
    expect(caught.fix).toContain('pg_stat_activity');

    await blocker.execute(sql`ROLLBACK`);
    await owner.execute(sql`drop table x_live_lock`);
  });
});
