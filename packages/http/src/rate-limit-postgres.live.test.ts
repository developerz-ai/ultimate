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
