// `ScheduledFire.watermarkMs` on the real store: the occurrence's jobs are queued and the
// watermark lands PAST it, so the occurrences `run-once` drops are behind the fence. Opt-in
// (`.job.`): the embedded Postgres costs seconds to boot.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import { SQL_SCHEDULER_FIRE } from './driver-pg-operator-sql';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { postgresSchedulerState } from './scheduler-pg';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const request = (occurrenceMs: number) => ({
  name: 'digest',
  queue: 'default',
  input: {},
  idempotencyKey: `hourlyOnce:${occurrenceMs}:digest`,
  maxAttempts: 1,
  runAt: occurrenceMs,
});

describe('a fire that lands its watermark past its occurrence, on pg', () => {
  test('queues the occurrence and fences every occurrence it dropped', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const statements: string[] = [];
    const state = postgresSchedulerState({
      query(sql, params) {
        statements.push(sql);
        return pg.executor.query(sql, params);
      },
    });
    await state.markFired('hourlyOnce', T0);
    statements.length = 0;
    const at = T0 + 5 * HOUR_MS + 1_000;

    const results = await state.fire(driver, {
      task: 'hourlyOnce',
      occurrenceMs: T0 + HOUR_MS,
      watermarkMs: at,
      jobs: [request(T0 + HOUR_MS)],
    });

    expect(results?.map((result) => result.deduped)).toEqual([false]);
    // ONE statement: the watermark rides the fire, with no mark behind it to be lost in a crash.
    expect(statements).toEqual([SQL_SCHEDULER_FIRE]);
    expect(await state.lastFiredAt('hourlyOnce')).toBe(at);
    // 02:00 was missed and dropped: it is behind the watermark, so nothing fires it.
    const dropped = await state.fire(driver, {
      task: 'hourlyOnce',
      occurrenceMs: T0 + 2 * HOUR_MS,
      jobs: [request(T0 + 2 * HOUR_MS)],
    });
    expect(dropped).toBeUndefined();
    expect((await driver.introspect?.list())?.length).toBe(1);
    // What an operator reads as "last fired" is the occurrence that RAN, never the watermark.
    const fires = await driver.introspect?.taskFires();
    expect(fires?.find((fire) => fire.task === 'hourlyOnce')?.occurrenceMs).toBe(T0 + HOUR_MS);
  });
});
