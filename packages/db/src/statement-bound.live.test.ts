// A read's own bound, on Postgres: `pg_sleep` past it answers `X_DB_STATEMENT_TIMEOUT`, and the
// same connection's next statement has the role's bound back — the setting was transaction-local.
// `max: 1`, so "the next read" is provably the same backend. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { sql } from './sql';
import { withStatementTimeout } from './statement-bound';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · withStatementTimeout', () => {
  let client: PostgresClient;
  const roleBound = async (): Promise<string | undefined> =>
    (
      await client.one<{ ms: string }>(
        sql`select setting as ms from pg_settings where name = 'statement_timeout'`,
      )
    )?.ms;

  beforeAll(() => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
  });

  afterAll(async () => {
    await client.close();
  });

  test('past the bound: X_DB_STATEMENT_TIMEOUT; after it: the role bound, on the same backend', async () => {
    const before = await roleBound();
    const pid = await client.one<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const error = await withStatementTimeout(50, (tx) => tx.query(sql`select pg_sleep(1)`), {
      client,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: 'X_DB_STATEMENT_TIMEOUT' });
    expect(await client.one<{ pid: number }>(sql`select pg_backend_pid() as pid`)).toEqual(pid);
    expect(await roleBound()).toBe(before);
    expect(before).toBe('10000');
  });

  test('inside the bound the read answers, and the COMMITTED bound does not outlive it', async () => {
    const rows = await withStatementTimeout(2_000, (tx) => tx.query(sql`select 1 as one`), {
      client,
    });
    expect(rows).toEqual([{ one: 1 }]);
    // A session `set_config(…, false)` would survive this COMMIT and leave 2000 on the backend.
    expect(await roleBound()).toBe('10000');
  });
});
