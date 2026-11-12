// A RESTING worker on a real Postgres, woken only by what the database announces: a row another
// process queued due inside the rest, and a retry a stopping worker handed back. No in-process
// `signalEnqueued` anywhere — the notification crosses the LISTEN or nothing does. Fake timers move
// the loops; `pg.age` moves the database's clock by the same amount. Opt-in (`.job.`).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { setWakeLive, wakeIsLive } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import type { QueueWake } from './queue-wake';
import { startQueueWake } from './queue-wake';
import { jobWorker } from './worker';
import type { Worker } from './worker-types';

/** The embedded boot alone is tens of seconds (`driver-pg-lifecycle.job.test.ts`). */
setDefaultTimeout(120_000);

const FLOOR_MS = 250;
/** One fake-time step: the loops' timers fire, and the database's clock moves as far. */
const STEP_MS = 250;

let pg: EmbeddedPg;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
  jest.useFakeTimers();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  jest.useRealTimers();
  resetJobs();
  setWakeLive(false);
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((done) => setImmediate(done));
};

/** `ms` of fake time for the loops, and the same `ms` off every instant the database holds. */
async function advance(ms: number): Promise<void> {
  for (let gone = 0; gone < ms; gone += STEP_MS) {
    const step = Math.min(STEP_MS, ms - gone);
    await pg.age(step);
    jest.advanceTimersByTime(step);
    await flush();
  }
}

/** The database's `now()`, in epoch ms: what a row's `run_at` is measured against. */
async function databaseNow(): Promise<number> {
  const rows = await pg.executor.query<{ at: number | string }>(
    'select (extract(epoch from now()) * 1000)::bigint as at',
    [],
  );
  return Number(rows[0]?.at);
}

async function liveWake(): Promise<QueueWake> {
  const wake = startQueueWake({ listener: pg.listener, executor: pg.executor });
  cleanups.push(() => wake.stop());
  for (let turn = 0; turn < 200 && !wakeIsLive(); turn += 1) await flush();
  expect(wakeIsLive()).toBe(true);
  return wake;
}

function worker(run: () => Promise<void>, retryDelayMs?: number): { worker: Worker; name: string } {
  const handle = itemJob({
    run,
    ...(retryDelayMs === undefined
      ? {}
      : { retry: { attempts: 3, backoff: 'fixed', delay: retryDelayMs, jitter: 'none' } }),
  });
  const started = jobWorker({
    driver: postgresJobDriver({ executor: pg.executor }),
    pollIntervalMs: FLOOR_MS,
    heartbeatIntervalMs: 3_600_000,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    drainOnShutdown: false,
  });
  cleanups.push(() => started.stop());
  return { worker: started, name: handle.name };
}

describe('a resting worker on Postgres', () => {
  test("another process's row due 30 s out starts when due, not when the rest ends", async () => {
    await liveWake();
    const startedAt: number[] = [];
    const t0 = performance.now();
    const { worker: resting, name } = worker(() => {
      startedAt.push(performance.now() - t0);
      return Promise.resolve();
    });
    resting.start();
    await advance(10_000); // empty queue: resting on a horizon of nothing, a minute long
    // Another process: its own driver, no in-process signal. Due 30 s from the database's now.
    const producer = postgresJobDriver({ executor: pg.executor });
    await producer.enqueue({
      name,
      queue: 'default',
      input: { item: 'later' },
      idempotencyKey: 'rest:later',
      maxAttempts: 1,
      runAt: (await databaseNow()) + 30_000,
    });
    const enqueuedAt = performance.now() - t0;
    await advance(30_000 + 4 * STEP_MS);
    expect(startedAt).toHaveLength(1);
    expect((startedAt[0] ?? Number.POSITIVE_INFINITY) - enqueuedAt).toBeGreaterThanOrEqual(30_000);
  });

  test('a retry handed back by a worker that then stops starts when due on the one resting', async () => {
    await liveWake();
    let attempts = 0;
    let fail: (() => void) | undefined;
    const t0 = performance.now();
    const startedAt: number[] = [];
    const { worker: first, name } = worker(() => {
      attempts += 1;
      startedAt.push(performance.now() - t0);
      if (attempts > 1) return Promise.resolve();
      return new Promise<void>((_, reject) => {
        fail = () => reject(new RangeError('the first attempt fails'));
      });
    }, 10_000);
    const producer = postgresJobDriver({ executor: pg.executor });
    await producer.enqueue({
      name,
      queue: 'default',
      input: { item: 'flaky' },
      idempotencyKey: 'rest:flaky',
      maxAttempts: 3,
    });
    first.start();
    await advance(2 * STEP_MS);
    expect(attempts).toBe(1);
    // A second worker, resting on the running row's lease (30 s) — a horizon the retry moves.
    const { worker: resting } = worker(() => Promise.resolve());
    resting.start();
    await advance(5_000);
    first.stop().catch(() => undefined);
    fail?.();
    const failedAt = performance.now() - t0;
    await advance(10_000 + 4 * STEP_MS);
    expect(attempts).toBe(2);
    const retriedAt = startedAt[1] ?? Number.POSITIVE_INFINITY;
    expect(retriedAt - failedAt).toBeLessThanOrEqual(10_000 + 4 * STEP_MS);
  });
});
