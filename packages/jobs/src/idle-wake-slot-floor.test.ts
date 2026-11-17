// A worker polling faster than the wake slot (`pollIntervalMs` < `WAKE_SLOT_MS`), on a fake clock.
// Its two empty passes after a wake are over long before the slot that wake spoke for, so a row
// that slot left silent used to commit after the worker had settled and wait out the whole rest
// (`IDLE_REST_MAX_MS`). It settles only once the slot has passed (`IdleBackoff.settled`).

import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { WAKE_SLOT_MS } from './driver-pg-wake-sql';
import { setWakeLive, signalEnqueued } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { jobWorker } from './worker';

const BASE_MS = 1_790_000_000_000;
const FLOOR_MS = 25;

const clock: Clock = {
  now: () => new Date(BASE_MS + performance.now()),
  monotonic: () => performance.now(),
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  resetJobs();
  resetJobDriver();
  setWakeLive(false);
});

/** Fake time in `step` slices, letting each pass's promises settle between them. */
async function advance(ms: number, step = 5): Promise<void> {
  for (let gone = 0; gone < ms; gone += step) {
    jest.advanceTimersByTime(Math.min(step, ms - gone));
    for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
  }
}

test('a worker with a 25 ms floor finds the slot-silent row committed 60 ms after its wake', async () => {
  setWakeLive(true);
  const driver = memoryJobDriver({ clock });
  const started: number[] = [];
  const t0 = performance.now();
  const handle = itemJob({
    run() {
      started.push(performance.now() - t0);
      return Promise.resolve();
    },
  });
  const worker = jobWorker({
    driver,
    pollIntervalMs: FLOOR_MS,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    drainOnShutdown: false,
  });
  // On the DRIVER, so no in-process signal: rows another process committed.
  const commit = (item: string) =>
    driver.enqueue({
      name: handle.name,
      queue: 'default',
      input: { item },
      idempotencyKey: `floor:${item}`,
      maxAttempts: 3,
    });
  worker.start();
  try {
    await advance(10_000, 50); // idle: resting on an empty queue
    await commit('announced');
    // A peer claims it before this worker's woken pass does.
    const peer = { queues: ['default'], limit: 1, workerId: 'peer', visibilityTimeoutMs: 600_000 };
    expect(await driver.claim(peer)).toHaveLength(1);
    signalEnqueued('default'); // its NOTIFY
    await advance(60);
    // Same slot: `notifyJobReady` sends nothing for this one.
    await commit('silent');
    const committedAt = performance.now() - t0;
    await advance(5_000, 10);
    expect(started).toHaveLength(1);
    expect((started[0] ?? Number.POSITIVE_INFINITY) - committedAt).toBeLessThanOrEqual(
      WAKE_SLOT_MS,
    );
  } finally {
    await worker.stop();
  }
});
