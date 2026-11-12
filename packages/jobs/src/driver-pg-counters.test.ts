// The pg driver's settles feed its counter batch (`counter-batch.ts`), never a statement each: a
// landed ack or counted nack adds to it, a fenced-out settle adds nothing, a counter read flushes
// first so it sees this process's own settles, and `close()` writes what is left.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import { SQL_COUNTERS } from './driver-pg-operator-sql';
import { SQL_COUNTER_FLUSH } from './driver-pg-settle-sql';
import { SQL_ACK, SQL_NACK } from './driver-pg-sql';
import { COUNTER_BUCKET_MS } from './introspection';

const T0 = Date.UTC(2026, 10, 12, 9, 0, 30);

/** A settle lands (its row named `mail`) unless its id is `lost`; every other statement: none. */
function settlingExecutor(): PgExecutor & { readonly calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query<R>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
      calls.push({ sql, params: [...params] });
      const settle = sql === SQL_ACK || sql === SQL_NACK;
      const landed = settle && params[0] !== 'lost';
      return Promise.resolve((landed ? [{ name: 'mail' }] : []) as unknown as readonly R[]);
    },
  };
}

const flushed = (executor: ReturnType<typeof settlingExecutor>) =>
  executor.calls
    .filter((call) => call.sql === SQL_COUNTER_FLUSH)
    .map((call) => [call.params[0], JSON.parse(String(call.params[1])) as unknown]);

describe('the pg driver counts its settles in one batch', () => {
  test('landed settles are batched; a fenced-out one and a shed are not counted', async () => {
    const executor = settlingExecutor();
    const driver = postgresJobDriver({ executor, clock: frozenClock(T0) });
    const by = { workerId: 'w1', claim: 1 };
    expect(await driver.ack('a', { ...by, durationMs: 10.4 })).toBe(true);
    expect(await driver.ack('lost', { ...by, durationMs: 99 })).toBe(false);
    expect(await driver.nack('b', { ...by, delayMs: 0, durationMs: 5 })).toBe(true);
    const shed = { ...by, delayMs: 0, park: true, countsAsAttempt: false, durationMs: 50 };
    expect(await driver.nack('c', shed)).toBe(true);
    expect(await driver.nack('d', { ...by, delayMs: 0, deadLetter: true, durationMs: 1 })).toBe(
      true,
    );
    // Nothing written yet: four settles, four statements, and no counter upsert among them.
    expect(flushed(executor)).toEqual([]);
    await driver.close?.();
    const start = Date.UTC(2026, 10, 12, 9, 0, 0);
    expect(flushed(executor)).toEqual([
      [
        COUNTER_BUCKET_MS,
        [{ job: 'mail', startMs: start, done: 1, retried: 1, failed: 0, dead: 1, durationMs: 16 }],
      ],
    ]);
  });

  test('a counter read flushes this process’s batch before it reads', async () => {
    const executor = settlingExecutor();
    const driver = postgresJobDriver({ executor, clock: frozenClock(T0) });
    await driver.ack('a', { workerId: 'w1', claim: 1, durationMs: 3 });
    await driver.introspect?.counters({ job: 'mail', sinceMs: 0 });
    const order = executor.calls.map((call) => call.sql);
    expect(order).toEqual([SQL_ACK, SQL_COUNTER_FLUSH, SQL_COUNTERS]);
    await driver.close?.();
    // Written once: the close found nothing pending.
    expect(flushed(executor)).toHaveLength(1);
  });
});
