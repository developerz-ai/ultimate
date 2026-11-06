// A publish racing a park, on two sessions of a real server: whichever lands first, the waiter is
// answered — by the wake, by the second `find` after the park, or at worst by the backstop poll
// (set low here so the worst case is observable). Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { postgresEventBus } from './events-pg';
import { job, resetJobs } from './job';
import { jobWorker } from './worker';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_events_wake_race');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

afterEach(() => {
  resetJobs();
});

describe.skipIf(!hasPostgres)('live · postgres · a publish racing a park', () => {
  let admin: PostgresClient;
  let workerPod: PostgresClient;
  let webPod: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    workerPod = postgresClient({ url: probeUrl(), role: 'worker', profile: { max: 4 } });
    webPod = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await workerPod.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await workerPod.close();
    await webPod.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /**
   * One run whose wait is raced by a publish on the OTHER session, landed right after the
   * runner's `find` number `afterFind` answered — 1: between the first ask and the park, 2: after
   * the second ask, while the row is still `running`, which no wake touches.
   */
  async function race(afterFind: 1 | 2): Promise<{ ticks: number; answered: string[] }> {
    await workerPod.execute(raw('truncate x_jobs, x_job_steps, x_job_events'));
    const executor = dbExecutor(() => workerPod);
    const driver = postgresJobDriver({ executor });
    const publisher = postgresEventBus({ executor: dbExecutor(() => webPod), wakes: true });
    const bus = postgresEventBus({ executor, wakes: true });
    let finds = 0;
    const answered: string[] = [];
    const approve = job<{ id: string }>({
      name: `raceApprove${afterFind}`,
      tenant: 'none',
      input: t.object({ id: t.string }),
      idempotencyKey: ({ id }) => `race:${id}`,
      retry: { attempts: 1 },
      // The backstop, lowered so the worst case — an event no wake could reach — shows up here.
      eventPoll: '300ms',
      run: async ({ input, step }) => {
        const paid = await step.waitForEvent('paid', 'race.paid', {
          schema: t.object({ id: t.string }),
          match: input.id,
          required: true,
        });
        answered.push(paid?.id ?? 'none');
      },
    });
    const worker = jobWorker({
      driver,
      events: {
        wakes: true,
        now: () => bus.now(),
        find: async (event, key, after) => {
          const hit = await bus.find(event, key, after);
          finds += 1;
          if (finds === afterFind)
            await publisher.publish('race.paid', { id: 'inv-1' }, { correlationKey: 'inv-1' });
          return hit;
        },
      },
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    let ticks = 0;
    try {
      await driver.enqueue({
        name: approve.name,
        queue: 'default',
        input: { id: 'inv-1' },
        idempotencyKey: 'race:inv-1',
        maxAttempts: 1,
      });
      const deadline = performance.now() + 10_000;
      while (answered.length === 0 && performance.now() < deadline) {
        if ((await worker.tick()).length > 0) ticks += 1;
        // real-clock: a second Postgres session commits on its own time
        await Bun.sleep(20);
      }
    } finally {
      await worker.stop('test-end');
    }
    return { ticks, answered };
  }

  test('an event landing between the first find and the park is caught by the second find', async () => {
    expect(await race(1)).toEqual({ ticks: 1, answered: ['inv-1'] });
  }, 30_000);

  test('an event landing after the second find resumes the waiter on the backstop', async () => {
    expect(await race(2)).toEqual({ ticks: 2, answered: ['inv-1'] });
  }, 30_000);
});
