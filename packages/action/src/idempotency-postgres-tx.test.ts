// The Postgres store's statements and options. The transactional CASES are
// `idempotency-parity.test.ts` (memory and the embedded server) and the live suite.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { createPgliteClient, raw, withTransaction } from '@ultimat3/db';
import { withIdempotency } from './idempotency';
import { postgresIdempotencyStore, SQL_IDEMPOTENCY_RESERVE } from './idempotency-postgres';
import { postgresUnderTest } from './idempotency-tx-fixture';

describe('the store’s DDL', () => {
  test('is re-appliable: the column arrives on a table that predates it', async () => {
    const client = createPgliteClient();
    try {
      await postgresUnderTest(client);
      // A second boot must be a no-op, not `42701`.
      const under = await postgresUnderTest(client);
      expect((await under.store.reserve('k', 'hash')).created).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('a transaction on ANOTHER database', () => {
  test('the settle stays on the store’s own pool — the other database has no x_idempotency', async () => {
    const home = createPgliteClient();
    const shard = createPgliteClient();
    try {
      const { store } = await postgresUnderTest(home);
      await shard.execute(raw('create table shard_charges (id text primary key)'));

      // Sent to the shard's transaction, the settle is `42P01` there — which aborts the handler's
      // own unit of work — and the record on the home database is never settled.
      const outcome = await withTransaction(
        (tx) =>
          withIdempotency(store, 'k', { id: 1 }, async () => {
            await tx.execute(raw("insert into shard_charges (id) values ('ch_1')"));
            return { charged: 'ch_1' };
          }),
        { client: shard },
      );

      expect(outcome).toEqual({ value: { charged: 'ch_1' }, replayed: false });
      expect((await store.get('k'))?.status).toBe('settled');
      expect(await shard.query(raw('select id from shard_charges'))).toEqual([{ id: 'ch_1' }]);
      // Not bound to that transaction either, so the deadline never frees it.
      const [row] = await home.query<{ tx_bound: boolean }>(
        raw('select tx_bound from x_idempotency'),
      );
      expect(row?.tx_bound).toBe(false);
    } finally {
      await home.close();
      await shard.close();
    }
  });
});

describe('the reservation statement says whether its settle is bound to a transaction', () => {
  const origin = (): object => recording;
  const recording = (): { executor: PgExecutor; calls: (readonly unknown[])[] } => {
    const calls: (readonly unknown[])[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        if (sql === SQL_IDEMPOTENCY_RESERVE) calls.push(params);
        return Promise.resolve([]);
      },
    };
    return { executor, calls };
  };

  test('outside a transaction it is not, and the deadline rides beside the window', async () => {
    const { executor, calls } = recording();
    const store = postgresIdempotencyStore({
      executor,
      origin,
      windowMs: 60_000,
      reclaimAfterMs: () => 5_000,
    });
    await store.reserve('k', 'hash');
    expect(calls[0]?.slice(2)).toEqual(['hash', 60, false, 5]);
  });

  test('the deadline is read at each reservation — the app declares it after the store is built', async () => {
    const { executor, calls } = recording();
    let deadline = 5_000;
    const store = postgresIdempotencyStore({ executor, origin, reclaimAfterMs: () => deadline });
    await store.reserve('k', 'hash');
    deadline = 9_000;
    await store.reserve('k', 'hash');
    // `reserve` retries an empty answer, so each reservation is several identical statements.
    expect([...new Set(calls.map((params) => params[5]))]).toEqual([5, 9]);
  });

  test('no deadline (0), or one past the window, reclaims nothing before the window', async () => {
    const { executor, calls } = recording();
    for (const deadline of [0, 120_000]) {
      const store = postgresIdempotencyStore({
        executor,
        origin,
        windowMs: 60_000,
        reclaimAfterMs: () => deadline,
      });
      await store.reserve('k', 'hash');
    }
    expect([...new Set(calls.map((params) => params[5]))]).toEqual([60]);
  });

  test('a deadline that is not a finite count is refused where it is read, with a code', async () => {
    const { executor } = recording();
    for (const deadline of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const store = postgresIdempotencyStore({ executor, origin, reclaimAfterMs: () => deadline });
      const failure = await store.reserve('k', 'hash').catch((error: unknown) => error);
      expect(isUltimateError(failure)).toBe(true);
    }
  });
});
