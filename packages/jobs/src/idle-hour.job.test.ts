// What an idle job tier costs Postgres in an hour, counted statement by statement: a worker on two
// queues, the outbox relay and the scheduler leading three nightly tasks, with the wake proven and
// nothing to do. Fake timers move the loops through the hour in seconds. Measured 2026-11-12 at
// 543; a change that adds a statement to an idle loop moves this number, and must say why.
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, afterEach, expect, jest, setDefaultTimeout, test } from 'bun:test';
import type { Clock, PgExecutor } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { setWakeLive } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { postgresOutboxStore } from './outbox-pg';
import { outboxRelay } from './outbox-relay';
import { jobScheduler } from './scheduler';
import { postgresLeaseLeader, postgresSchedulerState } from './scheduler-pg';
import { resetTasks, task } from './task';
import { jobWorker } from './worker';

/** The embedded boot alone is tens of seconds (`driver-pg-lifecycle.job.test.ts`). */
setDefaultTimeout(300_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const STEP_MS = 100;

afterEach(() => {
  jest.useRealTimers();
  setWakeLive(false);
  resetTasks();
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

test('an idle hour: 543 statements — 300 worker, 60 relay, 183 scheduler', async () => {
  const pg = await embeddedPg();
  await pg.reset();
  const sent = new Map<string, number>();
  const counting = (role: string): PgExecutor => ({
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
      sent.set(role, (sent.get(role) ?? 0) + 1);
      return pg.executor.query<R>(text, values);
    },
  });
  const nightly = itemJob({ run: () => Promise.resolve() });
  const tasks = [0, 1, 2].map((i) =>
    task({
      name: `idle-nightly-${i}`,
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[nightly, { item: 'n' }]],
    }),
  );
  jest.useFakeTimers();
  setWakeLive(true);
  const clock: Clock = {
    now: () => new Date(1_790_000_000_000 + performance.now()),
    monotonic: () => performance.now(),
  };
  const worker = jobWorker({
    driver: postgresJobDriver({ executor: counting('worker'), clock }),
    queues: ['default', 'mail'],
    clock,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    drainOnShutdown: false,
  });
  const relayExecutor = counting('relay');
  const relay = outboxRelay({
    driver: postgresJobDriver({ executor: counting('relay'), clock }),
    store: postgresOutboxStore({
      executor: relayExecutor,
      txExecutor: () => relayExecutor,
      clock,
    }),
    clock,
    drainOnShutdown: false,
  });
  const scheduler = jobScheduler({
    driver: postgresJobDriver({ executor: counting('scheduler'), clock }),
    clock,
    state: postgresSchedulerState(counting('scheduler')),
    leader: postgresLeaseLeader({ executor: counting('scheduler'), holder: 'idle-node', clock }),
    tasks,
    drainOnShutdown: false,
  });
  const advance = async (ms: number): Promise<void> => {
    for (let gone = 0; gone < ms; gone += STEP_MS) {
      jest.advanceTimersByTime(STEP_MS);
      for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
    }
  };
  worker.start();
  relay.start();
  scheduler.start();
  let hour: Record<string, number> = {};
  try {
    await advance(MINUTE); // the boot's minute: registry row, first passes, the leader's grant
    sent.clear();
    await advance(HOUR);
    hour = Object.fromEntries(sent); // before the stops: their hand-backs are not idle cost
  } finally {
    await worker.stop();
    await relay.stop();
    await scheduler.stop();
  }
  // Worker: a claim and a depth read a rest (60 each), a registry renewal every 20 s (180).
  // Relay: one claim a rest. Scheduler: a leader renewal every 20 s, one counter fold.
  expect(hour).toEqual({ worker: 300, relay: 60, scheduler: 183 });
});
