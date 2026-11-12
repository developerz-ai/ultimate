// What a resting loop must still catch, on a fake clock. A woken loop passes again one floor later
// (the throttled wake's promise), so a row its wake did not announce starts within a floor or two;
// a due time a stopping worker held is announced to the loops that rest on; and a driver whose
// enqueues announce nothing never rests at all. Each failed as a rest of up to `IDLE_REST_MAX_MS`.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive, signalEnqueued, signalStaged } from './enqueue-signal';
import { WOKEN_IDLE_POLL_CEILING_MS } from './idle-backoff';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';
import { jobWorker } from './worker';

const BASE_MS = 1_790_000_000_000;
const FLOOR_MS = 250;

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
async function advance(ms: number, step = 10): Promise<void> {
  for (let gone = 0; gone < ms; gone += step) {
    jest.advanceTimersByTime(Math.min(step, ms - gone));
    for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
  }
}

describe('a woken worker', () => {
  test('finds the slot-silent row a floor later, after a peer took the announced one', async () => {
    setWakeLive(true);
    const driver = memoryJobDriver({ clock });
    // Only the silent row ever runs here: the announced one is the peer's.
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
        idempotencyKey: `slot:${item}`,
        maxAttempts: 3,
      });
    worker.start();
    try {
      await advance(10_000, 50); // idle: resting on an empty queue
      await commit('announced');
      // A peer claims it before this worker's woken pass does.
      const peer = {
        queues: ['default'],
        limit: 1,
        workerId: 'peer',
        visibilityTimeoutMs: 600_000,
      };
      expect(await driver.claim(peer)).toHaveLength(1);
      signalEnqueued('default'); // its NOTIFY
      await advance(60, 10);
      // Same 250 ms slot: `notifyJobReady` sends nothing for this one.
      await commit('silent');
      const committedAt = performance.now() - t0;
      await advance(5_000, 10);
      expect(started).toHaveLength(1);
      expect((started[0] ?? Number.POSITIVE_INFINITY) - committedAt).toBeLessThanOrEqual(
        2 * FLOOR_MS,
      );
    } finally {
      await worker.stop();
    }
  });
});

describe('a woken relay', () => {
  test('publishes a row staged here and committed after its first pass, a floor later', async () => {
    setWakeLive(true);
    const store = memoryOutboxStore({ clock });
    const driver = memoryJobDriver({ clock });
    const published: number[] = [];
    const t0 = performance.now();
    const relay = outboxRelay({
      driver: {
        ...driver,
        enqueueMany(requests) {
          for (const _ of requests) published.push(performance.now() - t0);
          return driver.enqueueMany(requests);
        },
      },
      store,
      clock,
      intervalMs: FLOOR_MS,
      drainOnShutdown: false,
    });
    relay.start();
    try {
      await advance(10_000, 50); // idle: resting on an empty outbox
      const tx = { id: 'slow' } as unknown as Tx;
      await store.stage(tx, {
        id: 'slow',
        runId: 'run-slow',
        job: 'notifySubscribers',
        queue: 'default',
        input: {},
        idempotencyKey: 'slot:slow',
        maxAttempts: 1,
        runAt: 0,
        stagedAt: 0,
      });
      signalStaged(); // this process staged it: not committed yet
      await advance(FLOOR_MS + 50, 10); // the floor pass ran, and found nothing
      await store.commit(tx);
      const committedAt = performance.now() - t0;
      await advance(5_000, 10);
      expect(published).toHaveLength(1);
      expect((published[0] ?? Number.POSITIVE_INFINITY) - committedAt).toBeLessThanOrEqual(
        2 * FLOOR_MS,
      );
    } finally {
      await relay.stop();
    }
  });
});

describe('a hand-back the worker that made it stops before', () => {
  test('a step.sleep is announced, so a resting peer starts it when due', async () => {
    setWakeLive(true);
    const driver = memoryJobDriver({ clock });
    const t0 = performance.now();
    const resumed: number[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const handle = itemJob({
      async run({ step }) {
        await gate;
        await step.sleep('nap', 10_000);
        resumed.push(performance.now() - t0);
      },
    });
    const options = {
      // Two workers of one process share the driver: a stop must not close it under the other.
      driver: { ...driver, close: () => Promise.resolve() },
      clock, // the sleep's wake time and the row's due time, on one clock
      pollIntervalMs: FLOOR_MS,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    };
    const first = jobWorker(options);
    await driver.enqueue({
      name: handle.name,
      queue: 'default',
      input: { item: 'nap' },
      idempotencyKey: 'slot:nap',
      maxAttempts: 3,
    });
    const peer = jobWorker(options);
    first.start();
    await advance(FLOOR_MS + 50, 10); // `first` holds it, under a 30 s lease
    peer.start();
    await advance(2_000, 10); // the peer rests on that lease: its horizon is 30 s out
    release?.(); // the run sleeps: handed back due in 10 s, which only `first` knows
    await advance(50, 10);
    await first.stop(); // and the timer that would have kept the 10 s goes with it
    const stoppedAt = performance.now() - t0;
    try {
      await advance(12_000, 10);
      expect(resumed).toHaveLength(1);
      expect(resumed[0] ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        stoppedAt + 10_000 + 2 * FLOOR_MS,
      );
    } finally {
      await peer.stop();
    }
  });
});

describe('a driver whose enqueues announce nothing (Redis: no `wake`)', () => {
  test('never rests, even with the Postgres LISTEN proven: its poll is the only finder', async () => {
    setWakeLive(true);
    const driver = memoryJobDriver({ clock });
    // The memory driver, minus the one member a Redis driver does not carry.
    const { wake: _announces, ...silent } = driver;
    let claims = 0;
    const worker = jobWorker({
      driver: {
        ...silent,
        claim(options) {
          claims += 1;
          return driver.claim(options);
        },
      },
      pollIntervalMs: FLOOR_MS,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await advance(60_000, 50);
      // The woken ceiling (5 s), never the minute's rest: an enqueue on Redis sends no NOTIFY.
      expect(claims).toBeGreaterThanOrEqual(10);
      expect((await worker.stats()).pollDelayMs).toBeLessThanOrEqual(WOKEN_IDLE_POLL_CEILING_MS);
    } finally {
      await worker.stop();
    }
  });
});
