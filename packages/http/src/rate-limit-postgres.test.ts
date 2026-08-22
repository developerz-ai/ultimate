// The shared store's PROTOCOL, driven through a recording executor: one atomic statement per
// take, the verdict read off the row rather than guessed from the token count, and a store that
// answers nothing refuses instead of inventing "allowed". The SQL's own arithmetic is the
// `.live.` twin's job — a scripted executor answers whatever the script says.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { Bucket } from './rate-limit';
import { memoryRateLimitStore, rateLimitDecision } from './rate-limit';
import type { PgExecutor } from './rate-limit-postgres';
import {
  postgresRateLimitStore,
  SQL_RATE_LIMIT_PURGE,
  SQL_RATE_LIMIT_TABLE,
  SQL_RATE_LIMIT_TAKE,
} from './rate-limit-postgres';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers each statement from a scripted queue and records what it was asked. */
function executor(answers: readonly (readonly Record<string, unknown>[])[]): {
  readonly exec: PgExecutor;
  readonly calls: readonly Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const exec: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      const answer = answers[index] ?? [];
      index += 1;
      return Promise.resolve(answer as readonly R[]);
    },
  };
  return { exec, calls };
}

const bucket: Bucket = { capacity: 3, refillPerSecond: 1 };

describe('the postgres rate-limit store', () => {
  test('declares itself shared, which is the whole reason it exists', () => {
    const { exec } = executor([]);
    expect(postgresRateLimitStore({ executor: exec }).scope).toBe('shared');
  });

  test('one statement per take, with the bucket and the caller clock as parameters', async () => {
    const { exec, calls } = executor([[{ tokens: 2, spent: true }]]);
    const store = postgresRateLimitStore({ executor: exec });
    const decision = await store.take('posts.create|ip:1.2.3.4', bucket, 1, 1_700_000_000_000);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
    // One statement, not a select-then-update: the atomicity is the point.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(SQL_RATE_LIMIT_TAKE);
    expect(calls[0]?.params).toEqual(['posts.create|ip:1.2.3.4', 3, 1, 1, 1_700_000_000_000]);
  });

  // The defect this column exists for: 0.5 tokens left is BOTH a spend that landed there and a
  // refusal that could not afford the cost, so a store reading the count alone answers one of
  // them wrong — and the wrong one is "allowed".
  test('the verdict is read off the row, never inferred from the token count', async () => {
    const { exec } = executor([[{ tokens: 0.5, spent: true }], [{ tokens: 0.5, spent: false }]]);
    const store = postgresRateLimitStore({ executor: exec });
    expect((await store.take('k', bucket, 1, 1_000)).allowed).toBe(true);
    const refused = await store.take('k', bucket, 1, 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  // A pooler in text mode hands back `'t'`, and `Boolean('f')` is `true` — the limiter would then
  // report every refusal as a grant.
  test("a text-mode 't'/'f' is read as the boolean it is", async () => {
    const { exec } = executor([[{ tokens: '0', spent: 'f' }]]);
    const store = postgresRateLimitStore({ executor: exec });
    const decision = await store.take('k', bucket, 1, 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  test('an executor that answers no row refuses, rather than inventing a decision', async () => {
    const { exec } = executor([[]]);
    const store = postgresRateLimitStore({ executor: exec });
    const failed = await store.take('k', bucket, 1, 1_000).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!isUltimateError(failed)) expect.unreachable('an unanswered take was allowed through');
    expect(failed.code).toBe('X_RATE_LIMIT_STORE_UNAVAILABLE');
    expect(failed.fix).toContain('x_rate_limit');
  });

  test('purgeExpired answers how many buckets it forgot', async () => {
    const { exec, calls } = executor([[{ key: 'a' }, { key: 'b' }]]);
    const store = postgresRateLimitStore({ executor: exec });
    expect(await store.purgeExpired(1_700_000_000_000)).toBe(2);
    expect(calls[0]?.sql.startsWith(SQL_RATE_LIMIT_PURGE)).toBe(true);
    expect(calls[0]?.sql).toContain('returning key');
  });

  // The purge measures against the CALLER's clock, never the server's: `last_ms` is written from
  // the caller's, so an offset between the two is read as refill nobody earned and every bucket a
  // throttled caller is sitting in is deleted — a free reset, handed out by the cleanup task.
  test('the purge asks the same clock the takes wrote', async () => {
    const { exec, calls } = executor([[]]);
    await postgresRateLimitStore({ executor: exec }).purgeExpired(1_700_000_000_000);
    expect(calls[0]?.params).toEqual([1_700_000_000_000]);
    expect(SQL_RATE_LIMIT_PURGE).not.toContain('now()');
  });

  test('the install statement is idempotent, because the boot runs it on every start', () => {
    expect(SQL_RATE_LIMIT_TABLE).toContain('create table if not exists x_rate_limit');
    expect(SQL_RATE_LIMIT_TABLE).toContain('create index if not exists');
  });

  // The repetition is load-bearing: only a direct column reference inside `do update` reads the
  // row as it is after the lock, so a CTE computing the refill once would lose a concurrent spend.
  test('the refill is computed inside the conflict clause, not from a snapshot', () => {
    expect(SQL_RATE_LIMIT_TAKE).toContain('on conflict (key) do update');
    expect(SQL_RATE_LIMIT_TAKE).not.toContain('with ');
    // Four direct reads of the locked row: the three arms of the `case` and the `spent` verdict.
    expect(SQL_RATE_LIMIT_TAKE.split('x_rate_limit.tokens').length - 1).toBe(4);
    // A clock that ran backwards must not buy refill: `last_ms` only moves forward.
    expect(SQL_RATE_LIMIT_TAKE).toContain('greatest(x_rate_limit.last_ms, $5::bigint)');
  });
});

describe('both stores answer the same numbers', () => {
  // `rateLimitDecision` is shared on purpose: two drivers deriving `retryAfterSeconds` separately
  // is two answers to "when may I come back", and one of them is wrong.
  test('a refusal at zero tokens reads identically from memory and from postgres', async () => {
    const memory = memoryRateLimitStore();
    for (let i = 0; i < 3; i += 1) await memory.take('k', bucket, 1, 1_000);
    const fromMemory = await memory.take('k', bucket, 1, 1_000);

    const { exec } = executor([[{ tokens: 0, spent: false }]]);
    const fromPostgres = await postgresRateLimitStore({ executor: exec }).take(
      'k',
      bucket,
      1,
      1_000,
    );
    expect(fromPostgres).toEqual(fromMemory);
    expect(fromMemory).toEqual(rateLimitDecision(bucket, 0, 1, false, 1_000));
  });
});
