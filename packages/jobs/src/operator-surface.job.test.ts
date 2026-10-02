// The operator surface against the PG driver and a real Postgres. The memory suite proves the
// logic; this proves the STATEMENTS — the keyset seek, the bulk CTEs, the pause the claim reads,
// the counter written inside the settle, the atomic fire and the counters' fold. Opt-in (`.job.`):
// booting Postgres costs seconds.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { createPgDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { COUNTER_TIERS } from './introspection';
import { resetJobs } from './job';
import type { OperatorHarness } from './operator-surface-fixture';
import {
  enqueueItem,
  itemJob,
  operatorOf,
  operatorSurfaceScenarios,
  workerOn,
} from './operator-surface-fixture';
import { operatorScopeScenarios } from './operator-surface-scope-fixture';
import { operatorSettleScenarios } from './operator-surface-settle-fixture';
import { createScheduler } from './scheduler';
import { createPgLeaseLeader, pgSchedulerState } from './scheduler-pg';
import { resetTasks, task } from './task';

/** `count` rows in one statement: a thousand round trips is not what this suite is measuring. */
const SEED = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, created_at)
select gen_random_uuid(), $1, $2, '{}'::jsonb, 'seed:' || $1 || ':' || g, gen_random_uuid(), 1, 1,
       $3, now() - (g * interval '1 millisecond')
  from generate_series(1, $4::int) as g
`;

const harness: OperatorHarness = {
  async driver(): Promise<JobDriver> {
    const pg = await embeddedPg();
    await pg.reset();
    return createPgDriver({ executor: pg.executor });
  },
  async elapse(_driver, ms): Promise<void> {
    await (await embeddedPg()).age(ms);
  },
  async seed(_driver, { name, state, count, queue = 'default' }): Promise<void> {
    await (await embeddedPg()).executor.query(SEED, [name, queue, state, count]);
  },
  async schedulerState() {
    return pgSchedulerState((await embeddedPg()).executor);
  },
};

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('the operator surface on the pg driver', () => {
  operatorSurfaceScenarios('pg', harness);
  operatorSettleScenarios('pg', harness);
  operatorScopeScenarios('pg', harness);

  test('pg: two workers are in the registry, and the killed one leaves by expiry', async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const alive = workerOn(harness, driver, 'worker-alive', ['default', 'mail']);
    const killed = workerOn(harness, driver, 'worker-killed');
    alive.start();
    killed.start();
    // `start()` announces at once; the statement is on the wire, not yet answered.
    await Bun.sleep(20);

    const both = await operator.workers();
    expect(both.map((worker) => worker.id).sort()).toEqual(['worker-alive', 'worker-killed']);
    expect(both.find((worker) => worker.id === 'worker-alive')).toMatchObject({
      host: 'host-of-worker-alive',
      queues: ['default', 'mail'],
      concurrency: 8,
      inFlight: [],
    });

    // `killed` never stops and never heartbeats again; `alive` stops cleanly. Past the TTL the
    // killed worker's row is gone with NO cleanup call, and the clean stop left none behind.
    await harness.elapse(driver, 31_000);
    expect(await operator.workers()).toEqual([]);
    const rows = await (await embeddedPg()).executor.query('select id from x_job_workers', []);
    expect(rows).toEqual([]);
    // Both loops are stopped for the suite's sake; neither stop is what removed the rows.
    await Promise.all([alive.stop(), killed.stop()]);
  });

  test('pg: the fold moves old one-minute buckets into five-minute ones, and keeps the sum', async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    for (let index = 0; index < 3; index += 1) await enqueueItem(driver, handle);
    await workerOn(harness, driver, 'worker-a').tick();
    const [minute, five] = COUNTER_TIERS;
    // TWO more one-minute buckets, written where the fold will find them: both a day old and
    // both inside ONE five-minute window, so the fold has two rows to add up, not one to move.
    const pg = (await embeddedPg()).executor;
    await pg.query(
      `insert into x_job_counters (job, bucket_ms, bucket_start, done, retried, dead, duration_ms)
       select 'folded', 60000,
              to_timestamp(floor(extract(epoch from now() - interval '26 hours') / 300) * 300)
                + (g * interval '1 minute'),
              g + 1, 1, g, 10
         from generate_series(0, 1) as g`,
      [],
    );

    // The settles of a moment ago are inside their tier; the day-old pair is not.
    expect(await operator.rollupCounters()).toBe(2);
    const folded = await operator.counters({ job: 'folded', sinceMs: 0 });
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      bucketMs: five.bucketMs,
      done: 3,
      retried: 2,
      failed: 0,
      dead: 1,
      durationMs: 20,
    });
    expect((folded[0]?.bucketStart ?? 1) % five.bucketMs).toBe(0);
    // Idempotent: a second node folding the same minute finds nothing left to move.
    expect(await operator.rollupCounters()).toBe(0);

    // And the fresh bucket folds once it too is past the tier — its count intact.
    await harness.elapse(driver, minute.keepMs + 600_000);
    expect(await operator.rollupCounters()).toBe(1);
    const aged = await operator.counters({ job: handle.name, sinceMs: 0 });
    expect(aged.map((bucket) => [bucket.bucketMs, bucket.done])).toEqual([[five.bucketMs, 3]]);
  });

  test('pg: an idle scheduler with 35 tasks sends a lease renewal every ten seconds, and nothing else', async () => {
    const driver = await harness.driver();
    const pg = (await embeddedPg()).executor;
    let statements = 0;
    const counting = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
        statements += 1;
        return pg.query<R>(text, values);
      },
    };
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const handle = itemJob({ run: () => Promise.resolve() });
    const tasks = Array.from({ length: 35 }, (_, index) =>
      task({
        name: `pg-idle-nightly-${index}`,
        cron: '0 3 * * *',
        tz: 'UTC',
        enqueue: () => [[handle, { item: 'nightly' }]],
      }),
    );
    const scheduler = createScheduler({
      // The queue's own statements are counted too: an idle round must not read the pause table.
      driver: createPgDriver({ executor: counting }),
      clock,
      state: pgSchedulerState(counting),
      leader: createPgLeaseLeader({ executor: counting, holder: 'idle-node' }),
      tasks,
    });
    // Arming: one watermark read and one write a task, the lease, and the first counter fold.
    await scheduler.tick();
    expect(statements).toBeGreaterThan(70);
    statements = 0;

    for (let second = 0; second < 60; second += 1) {
      clock.advance(1_000);
      expect(await scheduler.tick()).toEqual([]);
    }

    // Was ~72 a second. Six renewals of a 30-second lease in a minute, and not one read.
    expect(statements).toBe(6);
    await scheduler.stop();
    resetTasks();
    void driver;
  });

  test('pg: a fire that queues nothing still does not move a watermark it is behind', async () => {
    const driver = await harness.driver();
    const state = pgSchedulerState((await embeddedPg()).executor);
    await state.markFired('behind', 5_000_000);

    expect(await state.fire(driver, { task: 'behind', occurrenceMs: 4_000_000, jobs: [] })).toBe(
      undefined,
    );
    expect(await state.lastFiredAt('behind')).toBe(5_000_000);
    expect(await state.fire(driver, { task: 'behind', occurrenceMs: 6_000_000, jobs: [] })).toEqual(
      [],
    );
    expect(await state.lastFiredAt('behind')).toBe(6_000_000);
  });
});
