// The SQL's own arithmetic, against a real server. The scripted-executor twin proves the protocol
// and can prove nothing about the statement: a rate limiter whose refill maths was never executed
// is a security control nobody has run. The case that only a server can answer is the last one —
// eight concurrent takes against a bucket of four allow exactly four.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// table. Locally:
//
//   docker run -d --name x-rl -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/http/src/rate-limit-postgres.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Bucket } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import type { PgExecutor } from './rate-limit-postgres';
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
  await sql.unsafe(SQL_RATE_LIMIT_TABLE, []);
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
  test('spends, refuses, refills and caps exactly as the memory store does', async () => {
    const memory = memoryRateLimitStore();
    // Every instant the two are asked about, including a clock that ran backwards.
    const instants = [1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 9_000, 500];
    for (const nowMs of instants) {
      const fromPostgres = await store.take('parity', bucket, 1, nowMs);
      const fromMemory = await memory.take('parity', bucket, 1, nowMs);
      expect({ nowMs, ...fromPostgres }).toEqual({ nowMs, ...fromMemory });
    }
  });

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

  // The reason the refill expression is repeated inside `on conflict do update` rather than
  // computed once in a CTE: a CTE reads the statement's own snapshot, so concurrent takes would
  // each spend from the same pre-refill row and the losers' spends would vanish.
  test('eight concurrent takes against a bucket of four allow exactly four', async () => {
    const nowMs = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () => store.take('contended', bucket, 1, nowMs)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4);
    const rows = await sql.unsafe('select tokens from x_rate_limit where key = $1', ['contended']);
    expect(Number((rows as { readonly tokens: number }[])[0]?.tokens)).toBe(0);
  });

  // The second key is the assertion, not scenery: `delete from x_rate_limit` with no `where` also
  // empties the target, so a test that only looks at `resettable` passes on a store that drops
  // every bucket in the fleet — one caller's reset handing every other caller a full allowance.
  test('reset empties one key and leaves the others', async () => {
    const nowMs = Date.now();
    await store.take('resettable', bucket, 4, nowMs);
    await store.take('untouched', bucket, 4, nowMs);

    await store.reset('resettable');

    const rows = await sql.unsafe(
      'select key from x_rate_limit where key in ($1, $2) order by key',
      ['resettable', 'untouched'],
    );
    expect((rows as { readonly key: string }[]).map((row) => row.key)).toEqual(['untouched']);
    // And the survivor kept its SPEND, not just its row: a reset that refilled a neighbour's
    // bucket is the same free allowance one `delete` further along.
    expect((await store.take('untouched', bucket, 1, nowMs)).allowed).toBe(false);
  });
});
