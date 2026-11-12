// The per-process counter batch: many settles, one write per (job, minute) per flush; a failed
// write keeps its deltas for the next one; the timer exists only while something is pending.

import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import type { CounterFlushRow } from './counter-batch';
import { COUNTER_FLUSH_INTERVAL_MS, COUNTER_PENDING_MAX_ROWS, counterBatch } from './counter-batch';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

function harness(fail: () => boolean = () => false) {
  const writes: (readonly CounterFlushRow[])[] = [];
  const timers: { tick: () => void; intervalMs: number; cancelled: boolean }[] = [];
  const batch = counterBatch({
    write: (rows) => {
      if (fail()) return Promise.reject(new TypeError('pool closed'));
      writes.push(rows);
      return Promise.resolve();
    },
    schedule: (tick, intervalMs) => {
      const timer = { tick, intervalMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const armed = () => timers.filter((timer) => !timer.cancelled);
  return { batch, writes, timers, armed };
}

describe('counterBatch', () => {
  test('50 acks and one flush: one row, one write, the sums equal', async () => {
    const { batch, writes } = harness();
    for (let i = 0; i < 50; i += 1) batch.add('mail', 'done', 10, T0 + i * 100);
    await batch.flush();
    expect(writes).toEqual([
      [{ job: 'mail', startMs: T0, done: 50, retried: 0, failed: 0, dead: 0, durationMs: 500 }],
    ]);
    await batch.flush();
    expect(writes).toHaveLength(1);
  });

  test('one row per job and minute, ordered by job then bucket: two flushers lock in one order', async () => {
    const { batch, writes } = harness();
    batch.add('zeta', 'dead', 1, T0 + MINUTE);
    batch.add('alpha', 'retried', 2, T0 + MINUTE + 5);
    batch.add('alpha', 'failed', 3, T0 + 59_999);
    await batch.flush();
    expect(writes[0]?.map((row) => [row.job, row.startMs])).toEqual([
      ['alpha', T0],
      ['alpha', T0 + MINUTE],
      ['zeta', T0 + MINUTE],
    ]);
    expect(writes[0]?.[0]).toMatchObject({ failed: 1, durationMs: 3 });
  });

  test('a write that fails keeps its deltas: the next flush writes them with the new ones', async () => {
    let failing = true;
    const { batch, writes } = harness(() => failing);
    batch.add('mail', 'done', 5, T0);
    await expect(batch.flush()).rejects.toThrow('pool closed');
    failing = false;
    batch.add('mail', 'done', 7, T0 + 1);
    await batch.flush();
    expect(writes).toEqual([
      [{ job: 'mail', startMs: T0, done: 2, retried: 0, failed: 0, dead: 0, durationMs: 12 }],
    ]);
  });

  test('a settle that lands while a flush is on the wire is written by the next flush', async () => {
    const { batch, writes } = harness();
    batch.add('mail', 'done', 1, T0);
    const first = batch.flush();
    batch.add('mail', 'done', 1, T0);
    await first;
    await batch.flush();
    expect(writes.map((rows) => rows[0]?.done)).toEqual([1, 1]);
  });

  test('the timer is armed by the first add, every 10s, and disarmed once nothing is pending', async () => {
    const { batch, writes, timers, armed } = harness();
    expect(timers).toHaveLength(0);
    batch.add('mail', 'done', 1, T0);
    batch.add('mail', 'done', 1, T0);
    expect(armed()).toHaveLength(1);
    expect(timers[0]?.intervalMs).toBe(COUNTER_FLUSH_INTERVAL_MS);
    expect(COUNTER_FLUSH_INTERVAL_MS).toBe(10_000);
    timers[0]?.tick();
    await batch.flush(); // Joins the tick's flush.
    expect(writes).toHaveLength(1);
    // An idle process pays no timer at all.
    expect(armed()).toHaveLength(0);
  });

  test('stop flushes what is pending and disarms the timer', async () => {
    const { batch, writes, armed } = harness();
    batch.add('mail', 'retried', 4, T0);
    await batch.stop();
    expect(writes).toHaveLength(1);
    expect(armed()).toHaveLength(0);
  });

  test('writes failing for ever hold a bounded batch: the oldest buckets go, named in one warn', async () => {
    let failing = true;
    const { batch, writes } = harness(() => failing);
    const warns = spyOn(logger, 'warn');
    try {
      // One more bucket than the bound, two counts in the oldest.
      batch.add('mail', 'done', 1, T0);
      for (let i = 0; i <= COUNTER_PENDING_MAX_ROWS; i += 1) {
        batch.add('mail', 'done', 1, T0 + i * MINUTE);
      }
      await expect(batch.flush()).rejects.toThrow('pool closed');
      const dropped = warns.mock.calls.filter(([event]) => event === 'jobs.counters.dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.[1]).toMatchObject({ rows: 1, counts: 2 });
      failing = false;
      await batch.flush();
      expect(writes[0]).toHaveLength(COUNTER_PENDING_MAX_ROWS);
      expect(writes[0]?.[0]?.startMs).toBe(T0 + MINUTE);
    } finally {
      warns.mockRestore();
    }
  });
});
