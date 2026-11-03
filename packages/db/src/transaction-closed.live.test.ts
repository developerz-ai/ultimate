// The `Promise.all` straggler on Postgres, where a released pin is a real connection the pool hands
// to someone else. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { db, type PostgresClient, postgresClient, setDbClient } from './client';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe.skipIf(!hasPostgres)('live · postgres · a straggler on a finished transaction', () => {
  let client: PostgresClient;
  const count = async (): Promise<number> => {
    const rows = await client.query<{ total: number }>(
      sql`select count(*)::int as total from x_tx_closed_probe`,
    );
    return rows[0]?.total ?? -1;
  };

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    await client.execute(raw('drop table if exists x_tx_closed_probe'));
    await client.execute(raw('create table x_tx_closed_probe (id int primary key)'));
    setDbClient(client);
  });

  beforeEach(async () => {
    await client.execute(raw('delete from x_tx_closed_probe'));
  });

  afterAll(async () => {
    setDbClient(undefined);
    await client.execute(raw('drop table if exists x_tx_closed_probe'));
    await client.close();
  });

  const lateInsert = (ended: Promise<void>): Promise<unknown> =>
    ended.then(() => db().execute(sql`insert into x_tx_closed_probe values (1)`));

  test('after a rollback: refused, 0 rows', async () => {
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(
      () => {
        late = lateInsert(ended.promise);
        late.catch(() => undefined);
        return Promise.all([late, Promise.reject(new RangeError('the sibling failed'))]);
      },
      { client },
    ).catch(() => undefined);
    ended.resolve();
    const error = await late.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });

  test('a coded abort mid-body rolls back; an uncoded one commits', async () => {
    const timedOut = new UltimateError({
      code: 'X_TIMEOUT',
      cause: 'past the deadline',
      fix: 'raise it',
    });
    const body = (controller: AbortController, reason: unknown) =>
      runWithContext(ctxOf({ signal: controller.signal }), () =>
        withTransaction(
          async () => {
            await db().execute(sql`insert into x_tx_closed_probe values (2)`);
            controller.abort(reason);
          },
          { client },
        ),
      );
    expect(await body(new AbortController(), timedOut).catch((error: unknown) => error)).toBe(
      timedOut,
    );
    expect(await count()).toBe(0);
    await body(new AbortController(), new DOMException('gone', 'AbortError'));
    expect(await count()).toBe(1);
  });

  test('after a commit: refused, 0 rows', async () => {
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(
      async () => {
        late = lateInsert(ended.promise);
        late.catch(() => undefined);
      },
      { client },
    );
    ended.resolve();
    const error = await late.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(codeOf(error)).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });
});
