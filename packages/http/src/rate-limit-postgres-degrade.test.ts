// The shared store when the DATABASE is the thing that failed. Before: `take` rethrew
// `X_DB_UNAVAILABLE` and every request — a prerendered `GET /` included — answered 500 for the
// length of the blip. Now an unreachable store degrades to this process's memory for that decision
// (the limit still applies, per pod) and says so once per window, while any OTHER failure still
// refuses: a store answering wrongly is not a store that is down.

import { afterEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { setLogSink, UltimateError } from '@ultimat3/core';
import type { Bucket } from './rate-limit';
import { postgresRateLimitStore } from './rate-limit-postgres';

const bucket: Bucket = { capacity: 2, refillPerSecond: 0.001 };
const NOW = 1_700_000_000_000;

const failing = (error: unknown): PgExecutor => ({
  query: () => Promise.reject(error),
});

const coded = (code: string, meta?: Record<string, unknown>): UltimateError =>
  new UltimateError({ code, cause: 'the driver said no', fix: 'x doctor --json', meta });

let previousSink: ReturnType<typeof setLogSink> | undefined;
const collect = (): string[] => {
  const lines: string[] = [];
  previousSink = setLogSink((line) => {
    lines.push(line);
  });
  return lines;
};

afterEach(() => {
  setLogSink(previousSink);
  previousSink = undefined;
});

describe('the postgres rate-limit store over an unreachable database', () => {
  test('X_DB_UNAVAILABLE degrades to a per-process bucket that still limits', async () => {
    collect();
    const store = postgresRateLimitStore({ executor: failing(coded('X_DB_UNAVAILABLE')) });
    const first = await store.take('k', bucket, 1, NOW);
    const second = await store.take('k', bucket, 1, NOW);
    const third = await store.take('k', bucket, 1, NOW);
    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, false]);
    // `peek` runs on every request to a required route: it degrades the same way.
    expect((await store.peek('k', bucket, NOW)).remaining).toBe(0);
  });

  test('connection-class answers degrade too: pool exhausted, 08xxx, 57P0x', async () => {
    collect();
    for (const error of [
      coded('X_DB_POOL_EXHAUSTED'),
      coded('X_DB_STATEMENT_FAILED', { sqlState: '08006' }),
      coded('X_DB_STATEMENT_FAILED', { sqlState: '57P01' }),
    ]) {
      const store = postgresRateLimitStore({ executor: failing(error) });
      expect((await store.take('k', bucket, 1, NOW)).allowed).toBe(true);
    }
  });

  test('any other failure still refuses — a wrong answer is not an outage', async () => {
    collect();
    for (const error of [
      coded('X_DB_STATEMENT_FAILED', { sqlState: '42601' }),
      coded('X_DB_SCHEMA_STALE', { sqlState: '42P01' }),
      new TypeError('executor bug'),
    ]) {
      const store = postgresRateLimitStore({ executor: failing(error) });
      await expect(store.take('k', bucket, 1, NOW)).rejects.toBe(error);
    }
  });

  // A key the fallback exhausted in one outage, reset after the database came back, must not still
  // be denied in the next outage: `reset` clears the per-process bucket as well as the shared row.
  test('a reset after recovery clears the fallback too, so the next outage starts fresh', async () => {
    collect();
    let down = true;
    const statements: string[] = [];
    const store = postgresRateLimitStore({
      executor: {
        query: (text) => {
          if (down) return Promise.reject(coded('X_DB_UNAVAILABLE'));
          statements.push(text);
          return Promise.resolve([]);
        },
      },
    });
    for (let index = 0; index < 2; index += 1) await store.take('k', bucket, 1, NOW);
    expect((await store.take('k', bucket, 1, NOW)).allowed).toBe(false);

    down = false;
    await store.reset('k');
    expect(statements).toHaveLength(1);

    down = true;
    expect((await store.take('k', bucket, 1, NOW)).allowed).toBe(true);
  });

  test('one warn per window, not one per request', async () => {
    const lines = collect();
    const store = postgresRateLimitStore({ executor: failing(coded('X_DB_UNAVAILABLE')) });
    for (let index = 0; index < 50; index += 1) await store.take(`k${index}`, bucket, 1, NOW);
    const warned = () => lines.filter((line) => line.includes('http.rate_limit.degraded'));
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toContain('X_DB_UNAVAILABLE');
    // A minute later, still down: one more line, so a long outage is still visible.
    await store.take('k', bucket, 1, NOW + 60_000);
    expect(warned()).toHaveLength(2);
  });
});
