// What only this table can show, against a real server: the purge's clock, and a peek that leaves no
// row. Every answer the store owes through its port — refill maths, the race, a one-key reset — is
// `@ultimat3/testing`'s `rateLimitStoreConformance`, run over this store in
// `packages/testing/src/rate-limit-store-conformance-postgres.live.test.ts`.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// table. Locally:
//
//   docker run -d --name x-rl -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/http/src/rate-limit-postgres.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { Bucket } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import {
  type PostgresRateLimitStore,
  postgresRateLimitStore,
  SQL_RATE_LIMIT_TABLE,
  SQL_RATE_LIMIT_TAKE,
} from './rate-limit-postgres';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

/**
 * `Bun.SQL` is the one client this package can reach — `@ultimat3/http` has no `@ultimat3/db`
 * dependency, and a live test is not a reason to give it one. It has no `.query(text, values)`,
 * which is exactly what `PgExecutor`'s doc comment says; `unsafe` is the positional form, and
 * wrapping it in one line is the wrapping every host does.
 */
let sql: Bun.SQL;
let store: PostgresRateLimitStore;

const bucket: Bucket = { capacity: 4, refillPerSecond: 1 };

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 8 });
  await sql.unsafe('drop table if exists x_rate_limit', []);
  // One piece at a time, exactly as the boot's `framework-schema.ts` sends the DDL — and twice,
  // because every boot runs it again over the table it made.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const piece of SQL_RATE_LIMIT_TABLE.split(';')) {
      if (piece.trim().length > 0) await sql.unsafe(piece, []);
    }
  }
  const executor: PgExecutor = {
    query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      (await sql.unsafe(text, [...values])) as readonly R[],
  };
  store = postgresRateLimitStore({ executor });
});

afterAll(async () => {
  if (url === undefined) return;
  await sql.unsafe('drop table if exists x_rate_limit', []);
  await sql.end();
});

describeLive('live · postgres · the shared rate-limit store', () => {
  // `Date.now()` is the framework preload's FROZEN clock here, which is months away from the
  // server's — and that is the point: the purge must measure against the clock the takes wrote,
  // or the offset between the two reads as refill and deletes a bucket holding zero tokens.
  test('a bucket refilled to capacity is forgotten, one that has not is kept', async () => {
    const nowMs = Date.now();
    await store.take('forgettable', bucket, 1, nowMs - 60_000);
    await store.take('held', { capacity: 4, refillPerSecond: 0.00001 }, 4, nowMs);
    const purged = await store.purgeExpired(nowMs);
    expect(purged).toBeGreaterThanOrEqual(1);
    const rows = await sql.unsafe('select key from x_rate_limit order by key', []);
    const keys = (rows as { readonly key: string }[]).map((row) => row.key);
    expect(keys).toContain('held');
    expect(keys).not.toContain('forgettable');
  });

  // The peek runs on every request to a required route, so it must agree with the memory store AND
  // leave no trace: no row for a key never taken, no change to one that was.
  test('peek agrees with the memory store and writes nothing', async () => {
    const memory = memoryRateLimitStore();
    const count = async (): Promise<number> =>
      Number(
        (
          (await sql.unsafe('select count(*)::int as n from x_rate_limit', [])) as { n: number }[]
        )[0]?.n,
      );
    const before = await count();
    expect(await store.peek('never-taken', bucket, 1_000)).toEqual({
      remaining: 4,
      retryAfterSeconds: 0,
    });
    expect(await count()).toBe(before);

    await store.take('peeked', bucket, 4, 1_000);
    await memory.take('peeked', bucket, 4, 1_000);
    for (const nowMs of [1_000, 1_400, 2_000, 9_000]) {
      expect(await store.peek('peeked', bucket, nowMs)).toEqual(
        await memory.peek('peeked', bucket, nowMs),
      );
    }
    const row = (await sql.unsafe('select tokens, last_ms from x_rate_limit where key = $1', [
      'peeked',
    ])) as { tokens: number; last_ms: string }[];
    expect(Number(row[0]?.tokens)).toBe(0);
    expect(Number(row[0]?.last_ms)).toBe(1_000);
  });
});

// H5: a take must cost no WAL and stay a HOT update. The table is UNLOGGED (no WAL record per
// take; after a crash it comes back EMPTY, which is every bucket full — a brief free burst, never a
// lockout) at `fillfactor = 70` (room on the page for the new row version, so the update never
// touches the primary key index). `x_auth_lockouts` is not this table and stays logged.
describeLive('live · postgres · the rate-limit table writes no WAL', () => {
  test('it is unlogged, at fillfactor 70', async () => {
    const rows = (await sql.unsafe(
      `select relpersistence as persistence, array_to_string(reloptions, ',') as options
         from pg_class where oid = 'x_rate_limit'::regclass`,
      [],
    )) as { persistence: string; options: string | null }[];
    expect(rows[0]).toEqual({ persistence: 'u', options: 'fillfactor=70' });
  });

  test('a take writes no WAL record', async () => {
    await store.take('wal', bucket, 1, 1_000);
    const plan = (await sql.unsafe(`explain (analyze, wal, format json) ${SQL_RATE_LIMIT_TAKE}`, [
      'wal',
      bucket.capacity,
      bucket.refillPerSecond,
      1,
      2_000,
    ])) as { 'QUERY PLAN': { Plan: { 'WAL Records'?: number } }[] }[];
    expect(plan[0]?.['QUERY PLAN'][0]?.Plan['WAL Records']).toBe(0);
  });

  /**
   * `keys` distinct buckets, then `takes` more spread over them — every one past the first per key
   * an update. One key alone is HOT even on a full page (measured 0.999 on the v31 table); a table
   * of 2,000 live buckets is what production has: this shape measured 0.949 at fillfactor 70 and
   * 0.315 at the default 100.
   */
  const hotRatio = async (
    keys: number,
    takes: number,
  ): Promise<{ updates: number; ratio: number }> => {
    // One connection, so the counters this backend accumulated are the ones flushed below.
    const one = new Bun.SQL(url as string, { max: 1 });
    try {
      const single = postgresRateLimitStore({
        executor: {
          query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
            (await one.unsafe(text, [...values])) as readonly R[],
        },
      });
      const roomy = { capacity: 1_000_000, refillPerSecond: 1 };
      for (let key = 0; key < keys; key += 1) await single.take(`hot-${key}`, roomy, 1, 10_000);
      await one.unsafe('select pg_stat_force_next_flush()', []);
      const before = await hotCounts(one);
      for (let take = 0; take < takes; take += 1) {
        await single.take(`hot-${take % keys}`, roomy, 1, 20_000 + take);
      }
      await one.unsafe('select pg_stat_force_next_flush()', []);
      const after = await hotCounts(one);
      const updates = after.updates - before.updates;
      return { updates, ratio: (after.hot - before.hot) / updates };
    } finally {
      await one.end();
    }
  };

  test('1,000 takes on one key are HOT updates, more than 90% of them', async () => {
    const { updates, ratio } = await hotRatio(1, 1_000);
    expect(updates).toBe(1_000);
    expect(ratio).toBeGreaterThan(0.9);
  });

  test('3,000 takes over 2,000 live buckets stay HOT too — the page has room', async () => {
    const { updates, ratio } = await hotRatio(2_000, 3_000);
    expect(updates).toBe(3_000);
    expect(ratio).toBeGreaterThan(0.9);
  }, 30_000);
});

describeLive('live · postgres · upgrading a table an earlier boot created', () => {
  test('a logged table at the default fillfactor is converged by the next boot, rows and all', async () => {
    await sql.unsafe('drop table if exists x_rate_limit', []);
    await sql.unsafe(
      `create table x_rate_limit (key text primary key, tokens double precision not null,
         capacity double precision not null, refill_per_second double precision not null,
         last_ms bigint not null, spent boolean not null,
         updated_at timestamptz not null default now())`,
      [],
    );
    await store.take('kept', bucket, 3, 1_000);
    for (const piece of SQL_RATE_LIMIT_TABLE.split(';')) {
      if (piece.trim().length > 0) await sql.unsafe(piece, []);
    }
    const rows = (await sql.unsafe(
      `select relpersistence as persistence, array_to_string(reloptions, ',') as options
         from pg_class where oid = 'x_rate_limit'::regclass`,
      [],
    )) as { persistence: string; options: string | null }[];
    expect(rows[0]).toEqual({ persistence: 'u', options: 'fillfactor=70' });
    // `set unlogged` rewrites the table; the buckets it held survive the rewrite.
    expect((await store.peek('kept', bucket, 1_000)).remaining).toBe(1);
  });
});

const hotCounts = async (on: Bun.SQL): Promise<{ updates: number; hot: number }> => {
  const rows = (await on.unsafe(
    `select n_tup_upd as updates, n_tup_hot_upd as hot
       from pg_stat_user_tables where relid = 'x_rate_limit'::regclass`,
    [],
  )) as { updates: string | number; hot: string | number }[];
  return { updates: Number(rows[0]?.updates ?? 0), hot: Number(rows[0]?.hot ?? 0) };
};
