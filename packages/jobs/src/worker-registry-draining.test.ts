// A draining worker's registry row says so AT ONCE — a retire (`SIGUSR2`), a SIGTERM or a manual
// `stop()` — while it still holds its jobs. The row is the one place a queue-depth autoscaler can
// read it: a pod finishing a 2-hour run after a deploy holds a `running` row its replacement does
// not own, and counted as load (KEDA, `count(*) where state = 'running'`) it scaled the NEW
// ReplicaSet up for work nobody there could take — 1.84 pods average where 1 carried the load, in a
// production app deploying ~50 times a day. `SQL_SCALER_DEPTH` leaves those rows out.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { IntervalScheduler } from './renewal-timer';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

/** No renewal ever fires on its own: whatever the registry shows, the worker announced on purpose. */
const never: IntervalScheduler = () => () => undefined;

afterEach(() => {
  resetJobs();
});

describe('the registry row of a draining worker', () => {
  test('stop() stamps drainingAt before the held job ends, with no heartbeat in between', async () => {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    job({
      tenant: 'none',
      name: 'longRun',
      input: passthrough,
      idempotencyKey: () => 'long:1',
      retry: { attempts: 1 },
      run: async () => {
        started();
        await held;
      },
    });
    const driver = memoryJobDriver();
    const registry = driver.introspect;
    if (registry === undefined) return expect.unreachable('the memory driver has a registry');
    await driver.enqueue({
      name: 'longRun',
      queue: 'default',
      input: {},
      idempotencyKey: 'long:1',
      maxAttempts: 1,
    });
    const worker = jobWorker({
      driver,
      context,
      clock: frozenClock(0),
      schedule: never,
      pollIntervalMs: 60_000,
      drainOnShutdown: false,
    });
    worker.start();
    const tick = worker.tick();
    await running;
    expect((await registry.workers())[0]?.drainingAt).toBeUndefined();

    const stopping = worker.stop();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const [row] = await registry.workers();
    expect(row?.inFlight).toHaveLength(1);
    expect(typeof row?.drainingAt).toBe('number');

    release();
    await tick;
    await stopping;
    // A clean stop still hands the row back.
    expect(await registry.workers()).toEqual([]);
  });
});
