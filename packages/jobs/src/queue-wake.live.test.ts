// The cross-process wake against a real server, with two POOLS standing in for two pods: the
// worker's, which holds the `LISTEN` session, and a web pod's, which only enqueues. The one thing
// the embedded suite cannot show is here — the session is killed under the listener, and the wake
// comes back on its own. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, raw, sql } from '@ultimat3/db';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { setWakeLive, wakeIsLive } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { startQueueWake } from './queue-wake';
import { createWorker } from './worker';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = 'x_jobs_wake_live';
const LISTENER_APP = 'x-wake-live-worker';

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const executorFor = (client: PostgresClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values }),
});

async function until(condition: () => boolean | Promise<boolean>, budgetMs = 8_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await Bun.sleep(5);
  }
}

// File scope, and guarded on nothing: Bun evaluates a skipped file's module body too.
afterEach(() => {
  resetJobs();
  setWakeLive(false);
});

describe.skipIf(!hasPostgres)('live · postgres · the cross-process wake', () => {
  let admin: PostgresClient;
  let workerPod: PostgresClient;
  let webPod: PostgresClient;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    admin = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.execute(raw(`create database ${PROBE_DB}`));
    workerPod = createPostgresClient({
      url: probeUrl(),
      role: 'worker',
      applicationName: LISTENER_APP,
    });
    webPod = createPostgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
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

  test('a web pod enqueues, an idle worker pod starts the job; the listener is killed, and it does so again', async () => {
    const wake = startQueueWake({ listener: workerPod, executor: executorFor(workerPod) });
    cleanups.push(() => wake.stop());
    await until(() => wakeIsLive());

    const started: { item: string; at: number }[] = [];
    const handle = itemJob({
      run({ input }) {
        started.push({ item: input.item, at: performance.now() });
        return Promise.resolve();
      },
    });
    const worker = createWorker({
      driver: createPgDriver({ executor: executorFor(workerPod) }),
      pollIntervalMs: 25,
      idlePollMaxMs: 60_000,
      heartbeatIntervalMs: 3_600_000,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    worker.start();
    cleanups.push(() => worker.stop());
    const web = createPgDriver({ executor: executorFor(webPod) });
    const enqueueFromWeb = async (item: string): Promise<number> => {
      await until(async () => (await worker.stats()).pollDelayMs >= 800);
      const before = performance.now();
      await web.enqueue({
        name: handle.name,
        queue: 'default',
        input: { item },
        idempotencyKey: `live:${item}`,
        maxAttempts: 1,
        // The test preload freezes this process's `Date`; the server's clock is real.
        runAt: 1,
      });
      await until(() => started.some((entry) => entry.item === item), 3_000);
      return (started.find((entry) => entry.item === item)?.at ?? 0) - before;
    };

    // The wait in hand is 800 ms or more; the job starts in a round trip or two.
    expect(await enqueueFromWeb('first')).toBeLessThan(200);

    // Kill the session the LISTEN is held on.
    const sessions = await admin.query<{ pid: number }>(
      sql`select pid from pg_stat_activity
           where application_name = ${LISTENER_APP} and query ilike 'listen%'`,
    );
    expect(sessions).toHaveLength(1);
    await admin.execute(sql`select pg_terminate_backend(${sessions[0]?.pid ?? 0})`);
    // The driver re-dials; the wake is un-proven until its own probe has crossed the new session.
    await until(async () => {
      const now = await admin.query<{ pid: number }>(
        sql`select pid from pg_stat_activity
             where application_name = ${LISTENER_APP} and query ilike 'listen%'`,
      );
      return now.length === 1 && now[0]?.pid !== sessions[0]?.pid && wakeIsLive();
    });

    expect(await enqueueFromWeb('after-the-kill')).toBeLessThan(200);
  });
});
