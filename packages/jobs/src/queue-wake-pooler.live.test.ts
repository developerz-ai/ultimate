// The worker through a real transaction pooler, the one role that may run there at a cost: `LISTEN`
// resolves, nothing is ever delivered, the wake stays unproven and says so once, and the poll still
// starts the job a web pod committed. Skips unless `TEST_POOLER_URL` and `TEST_DATABASE_URL` are set.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, probeDatabaseName, setLogSink, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { setWakeLive } from './enqueue-signal';
import { IDLE_POLL_CEILING_MS } from './idle-backoff';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { startQueueWake } from './queue-wake';
import { jobWorker } from './worker';

const poolerUrl = Bun.env['TEST_POOLER_URL'];
const directUrl = Bun.env['TEST_DATABASE_URL'];
const hasPooler =
  typeof poolerUrl === 'string' &&
  poolerUrl.length > 0 &&
  typeof directUrl === 'string' &&
  directUrl.length > 0;
const PROBE_DB = probeDatabaseName('x_wake_pooler_live');

/** What a loop may add to the ceiling on a loaded runner, and still have honoured it. */
const PICKUP_SLACK_MS = 1_500;

const executorFor = (client: PostgresClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values }),
});

const inProbe = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

// File scope, and guarded on nothing: Bun evaluates a skipped file's module body too.
afterEach(() => {
  resetJobs();
  setWakeLive(false);
});

describe.skipIf(!hasPooler)('live · the worker through a transaction pooler', () => {
  let admin: PostgresClient;
  let workerPod: PostgresClient;
  let webPod: PostgresClient;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    admin = postgresClient({ url: directUrl ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    workerPod = postgresClient({
      url: inProbe(poolerUrl ?? ''),
      role: 'worker',
      env: { DATABASE_POOLER: 'transaction' },
    });
    webPod = postgresClient({
      url: inProbe(poolerUrl ?? ''),
      role: 'web',
      env: { DATABASE_POOLER: 'transaction' },
      profile: { max: 2 },
    });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await workerPod.execute(raw(statement));
    }
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    await workerPod.close();
    await webPod.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('the wake stays off, says so once, and an idle worker still starts the job on the poll', async () => {
    const unverified: string[] = [];
    const previous = setLogSink((line) => {
      const parsed = JSON.parse(line) as { readonly msg?: string; readonly event?: string };
      const event = parsed.msg ?? parsed.event;
      if (event === 'jobs.wake.unverified') unverified.push(event);
    });
    cleanups.push(async () => {
      setLogSink(previous);
    });
    const { promise: reported, resolve: heard } = Promise.withResolvers<void>();
    let settled = false;
    const wake = startQueueWake({
      listener: workerPod,
      executor: executorFor(workerPod),
      verifyTimeoutMs: 50,
      // The verdict's own timer, wrapped to tell the test when it has fired.
      setTimer: (run, delayMs) => {
        // real-clock: the verdict waits on a pooler's real silence, 50 ms of it.
        const timer = setTimeout(() => {
          run();
          if (!settled) {
            settled = true;
            heard();
          }
        }, delayMs);
        return () => clearTimeout(timer);
      },
    });
    cleanups.push(() => wake.stop());
    await reported;

    expect(wake.live()).toBe(false);
    expect(unverified).toEqual(['jobs.wake.unverified']);

    const started = Promise.withResolvers<number>();
    const handle = itemJob({
      run() {
        started.resolve(performance.now());
        return Promise.resolve();
      },
    });
    const worker = jobWorker({
      driver: postgresJobDriver({ executor: executorFor(workerPod) }),
      pollIntervalMs: 25,
      heartbeatIntervalMs: 3_600_000,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    worker.start();
    cleanups.push(() => worker.stop());
    // Backed off all the way, so what starts the job is the poll at its ceiling and nothing sooner.
    for (let pass = 0; pass < 2_000; pass += 1) {
      if ((await worker.stats()).pollDelayMs >= IDLE_POLL_CEILING_MS) break;
      await webPod.query(raw('select pg_sleep(0.01)'));
    }
    expect((await worker.stats()).pollDelayMs).toBe(IDLE_POLL_CEILING_MS);

    const enqueuedAt = performance.now();
    await postgresJobDriver({ executor: executorFor(webPod) }).enqueue({
      name: handle.name,
      queue: 'default',
      input: { item: 'through' },
      idempotencyKey: 'pooler:through',
      maxAttempts: 1,
      // The test preload freezes this process's `Date`; the server's clock is real.
      runAt: 1,
    });
    const startedAt = await started.promise;

    expect(startedAt - enqueuedAt).toBeLessThan(IDLE_POLL_CEILING_MS + PICKUP_SLACK_MS);
    expect(wake.live()).toBe(false);
    expect(unverified).toHaveLength(1);
  }, 20_000);
});
