// The cross-process wake against a real server, with two POOLS standing in for two pods: the
// worker's, which holds the `LISTEN` session, and a web pod's, which only enqueues. The one thing
// the embedded suite cannot show is here — the session is killed under the listener, and the wake
// comes back on its own. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, sql } from '@ultimat3/db';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { JOBS_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD } from './driver-pg-wake-sql';
import { onEnqueued, setWakeLive, wakeIsLive } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { startQueueWake } from './queue-wake';
import { jobWorker } from './worker';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_wake_live');
const LISTENER_APP = 'x-wake-live-worker';
/** How long a job gets to start: a small part of the rest its worker is first seen taking. */
const START_BUDGET_MS = 3_000;
const IDLE_REST_MS = 60_000;
/** How often the event loop's lag is sampled; a stall shows as a sample this much late. */
const LAG_SAMPLE_MS = 20;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const executorFor = (client: PostgresClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values }),
});

/** `explain` is read only on a miss: what state the wait gave up in, so a flake is evidence. */
async function until(
  condition: () => boolean | Promise<boolean>,
  budgetMs = 8_000,
  explain: () => Promise<string> = () => Promise.resolve(''),
): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) {
      expect.unreachable(`the condition never became true ${await explain()}`);
    }
    // real-clock: paces reads of a real server's state — a NOTIFY crossing a socket, a re-dial.
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
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    workerPod = postgresClient({
      url: probeUrl(),
      role: 'worker',
      applicationName: LISTENER_APP,
    });
    webPod = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
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
    // Issue #1167's two vantage points, read only on a miss: a second session, which says whether
    // Postgres delivered the notification at all, and the signal the worker's loop subscribes to.
    // Each stamped `<queue>@<ms after its enqueue began>`, beside the worst stall of
    // this process's event loop: a notification that arrived on time and was read late is a
    // starved loop, which no bound on the wake can tell from a lost one.
    let enqueuedAt = performance.now();
    const stamp = (queue: string): string =>
      `${queue === WAKE_REPROVE_PAYLOAD ? '<re-proof>' : queue}@${Math.round(performance.now() - enqueuedAt)}ms`;
    const witnessed: string[] = [];
    const witness = await webPod.listen(JOBS_WAKE_CHANNEL, (queue) => witnessed.push(stamp(queue)));
    cleanups.push(() => witness.unlisten());
    const heard: string[] = [];
    const stopHearing = onEnqueued((queue) => heard.push(stamp(queue ?? '<any queue>')));
    cleanups.push(() => Promise.resolve(stopHearing()));
    let lagTick = performance.now();
    let worstLagMs = 0;
    // real-clock: samples the real event loop's stalls, which a fake timer cannot have.
    const lagSampler = setInterval(() => {
      const now = performance.now();
      worstLagMs = Math.max(worstLagMs, now - lagTick - LAG_SAMPLE_MS);
      lagTick = now;
    }, LAG_SAMPLE_MS);
    cleanups.push(() => Promise.resolve(clearInterval(lagSampler)));

    const wake = startQueueWake({ listener: workerPod, executor: executorFor(workerPod) });
    cleanups.push(() => wake.stop());
    await until(() => wakeIsLive());

    const started: string[] = [];
    const handle = itemJob({
      run({ input }) {
        started.push(input.item);
        return Promise.resolve();
      },
    });
    const worker = jobWorker({
      driver: postgresJobDriver({ executor: executorFor(workerPod) }),
      pollIntervalMs: 25,
      idlePollMaxMs: IDLE_REST_MS,
      heartbeatIntervalMs: 3_600_000,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    worker.start();
    cleanups.push(() => worker.stop());
    const web = postgresJobDriver({ executor: executorFor(webPod) });
    // Resting: the next poll is a minute off, so a start inside the budget can only be the wake's.
    // No bound on how fast — a loaded machine broke that one (3 of 60 runs past 200 ms at load 85).
    const enqueueFromWeb = async (item: string): Promise<void> => {
      await until(async () => (await worker.stats()).pollDelayMs === IDLE_REST_MS);
      witnessed.length = 0;
      heard.length = 0;
      worstLagMs = 0;
      enqueuedAt = performance.now();
      await web.enqueue({
        name: handle.name,
        queue: 'default',
        input: { item },
        idempotencyKey: `live:${item}`,
        maxAttempts: 1,
        // The test preload freezes this process's `Date`; the server's clock is real.
        runAt: 1,
      });
      await until(
        () => started.includes(item),
        START_BUDGET_MS,
        // Issue #1167: this wait missed once in CI and never locally. What a miss needs to tell:
        // `witnessed` without the queue, Postgres sent nothing; `witnessed` but not `heard`, the
        // worker's session lost it; `heard` with the row `ready`, the loop did not claim it; the
        // row `running` or `done`, the claim happened and the run is what to read.
        async () =>
          JSON.stringify({
            rows: await webPod.query(
              sql`select state, attempt, run_at, created_at from x_jobs
                   where idempotency_key = ${`live:${item}`}`,
            ),
            witnessed,
            heard,
            gaveUpAtMs: Math.round(performance.now() - enqueuedAt),
            worstEventLoopLagMs: Math.round(worstLagMs),
            wakeIsLive: wakeIsLive(),
            wakeLive: wake.live(),
            worker: await worker.stats(),
            listeners: await admin.query(
              sql`select pid, state, query from pg_stat_activity
                   where application_name = ${LISTENER_APP} and query ilike 'listen%'`,
            ),
          }),
      );
    };

    await enqueueFromWeb('first');

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

    await enqueueFromWeb('after-the-kill');
  });
});
