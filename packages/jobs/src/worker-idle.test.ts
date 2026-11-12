// What an idle worker's long rest must still catch, on a fake clock. With the wake live it claims
// once a minute at most (`IDLE_REST_MAX_MS`), and four things the 5 s poll used to catch are each
// held to a bound well under that: a notification lost with its session, a row due by the clock, a
// crashed worker's lapsed lease and a resumed queue. A loop that just slept 60 s fails all but one.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import type { ClaimOptions, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive, signalEnqueued } from './enqueue-signal';
import { IDLE_POLL_CEILING_MS, IDLE_REST_MAX_MS } from './idle-backoff';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { jobWorker } from './worker';
import type { Worker } from './worker-types';

const BASE_MS = 1_790_000_000_000;
const FLOOR_MS = 250;

/** The memory driver's clock, moved by the same fake timers that move the loop. */
const clock: Clock = {
  now: () => new Date(BASE_MS + performance.now()),
  monotonic: () => performance.now(),
};
const nowMs = (): number => clock.now().getTime();

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  resetJobs();
  resetJobDriver();
  setWakeLive(false);
});

const context = () => ctxOf({ role: 'worker', buildId: 'test' });

/** Fake time in `step` slices, letting each pass's promises settle between them. */
async function advance(ms: number, step = 10): Promise<void> {
  for (let gone = 0; gone < ms; gone += step) {
    jest.advanceTimersByTime(Math.min(step, ms - gone));
    for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
  }
}

interface Harness {
  readonly driver: ReturnType<typeof memoryJobDriver>;
  readonly worker: Worker;
  /** Every claim the worker made, by fake time since start. */
  readonly claims: number[];
  /** When the worker started the job, by fake time since start. */
  readonly started: number[];
  readonly handle: ReturnType<typeof itemJob>;
}

/**
 * A worker on one queue over the memory driver. A row enqueued on the DRIVER announces nothing —
 * the in-process signal is the job handle's — so it models one another process committed whose
 * NOTIFY never arrived; `signalEnqueued` after it is the notification that did.
 */
function harness(): Harness {
  const driver = memoryJobDriver({ clock });
  const claims: number[] = [];
  const started: number[] = [];
  const t0 = performance.now();
  const counted: JobDriver = {
    ...driver,
    claim(options: ClaimOptions) {
      claims.push(performance.now() - t0);
      return driver.claim(options);
    },
  };
  const handle = itemJob({
    run() {
      started.push(performance.now() - t0);
      return Promise.resolve();
    },
  });
  const worker = jobWorker({
    driver: counted,
    pollIntervalMs: FLOOR_MS,
    context,
    drainOnShutdown: false,
  });
  return { driver, worker, claims, started, handle };
}

const enqueue = (h: Harness, item: string, runAt?: number) =>
  h.driver.enqueue({
    name: h.handle.name,
    queue: 'default',
    input: { item },
    idempotencyKey: `idle:${item}`,
    maxAttempts: 3,
    ...(runAt === undefined ? {} : { runAt }),
  });

describe('an idle worker with a live wake', () => {
  test('rests up to a minute between claims on an empty queue', async () => {
    setWakeLive(true);
    const h = harness();
    h.worker.start();
    try {
      await advance(10 * 60_000, 50);
      // Ten minutes: the first pass, then one per IDLE_REST_MAX_MS — never one per 5 s.
      expect(h.claims.length).toBeLessThanOrEqual(12);
      expect(h.claims.length).toBeGreaterThanOrEqual(10);
    } finally {
      await h.worker.stop();
    }
  });

  test('a notification lost while the wake stays live: found within the rest', async () => {
    setWakeLive(true);
    const h = harness();
    h.worker.start();
    try {
      await advance(5_000, 50);
      await enqueue(h, 'unheard');
      await advance(IDLE_REST_MAX_MS + FLOOR_MS, 50);
      expect(h.started).toHaveLength(1);
    } finally {
      await h.worker.stop();
    }
  });

  test('a notification lost WITH its session: the rest is cut to the short ceiling', async () => {
    setWakeLive(true);
    // Ten seconds into a rest, so a loop that armed a minute is still asleep when the session goes.
    const lostAt = 130_000;
    const h = harness();
    h.worker.start();
    try {
      await advance(lostAt, 50);
      setWakeLive(false); // the LISTEN session died: nothing announces work any more
      await enqueue(h, 'unheard');
      await advance(2 * IDLE_POLL_CEILING_MS + FLOOR_MS, 10);
      expect(h.started).toHaveLength(1);
      expect(h.started[0] ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        lostAt + 2 * IDLE_POLL_CEILING_MS + FLOOR_MS,
      );
    } finally {
      await h.worker.stop();
    }
  });

  test('a row due by the clock is claimed when it falls due: exactly two claims', async () => {
    setWakeLive(true);
    const h = harness();
    h.worker.start();
    try {
      await advance(FLOOR_MS + 50); // the first pass: empty
      const before = h.claims.length;
      await enqueue(h, 'later', nowMs() + 30_000);
      signalEnqueued('default'); // its NOTIFY: one more pass, empty, that learns the due time
      await advance(30_000 + FLOOR_MS, 10);
      expect(h.started).toHaveLength(1);
      // The wake's pass, then the one at the due time. A 5 s poll made six; a 60 s rest, one late.
      expect(h.claims.length - before).toBe(2);
      const at = h.started[0] ?? Number.POSITIVE_INFINITY;
      expect(at).toBeLessThanOrEqual(FLOOR_MS + 50 + 30_000 + FLOOR_MS);
    } finally {
      await h.worker.stop();
    }
  });

  test("a crashed worker's lease is re-claimed when it lapses, not a minute later", async () => {
    setWakeLive(true);
    const h = harness();
    await enqueue(h, 'orphan');
    // The worker that held it died: claimed, never acked, a 20 s lease.
    const [held] = await h.driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 20_000,
      workerId: 'crashed',
    });
    expect(held).toBeDefined();
    h.worker.start();
    try {
      await advance(20_000 + 2 * FLOOR_MS, 10);
      expect(h.started).toHaveLength(1);
    } finally {
      await h.worker.stop();
    }
  });

  test('a paused queue with a due row rests, and its resume wakes the worker within one tick', async () => {
    setWakeLive(true);
    const h = harness();
    const operator = h.driver.introspect;
    if (operator === undefined) return expect.unreachable('the memory driver ships an operator');
    await operator.pauseQueue('default');
    await enqueue(h, 'held');
    h.worker.start();
    try {
      await advance(30_000, 50);
      // The paused row is no due time: a horizon that counted it would spin at the floor.
      expect(h.claims.length).toBeLessThanOrEqual(3);
      expect(h.started).toHaveLength(0);
      await operator.resumeQueue('default');
      await advance(FLOOR_MS, 10);
      expect(h.started).toHaveLength(1);
    } finally {
      await h.worker.stop();
    }
  });
});

describe('an idle worker without a live wake', () => {
  test('keeps the short ceiling: no minute-long rest without a wake to cut it', async () => {
    const h = harness();
    h.worker.start();
    try {
      await advance(60_000, 50);
      expect(h.claims.length).toBeGreaterThanOrEqual(60_000 / IDLE_POLL_CEILING_MS - 2);
      const stats = await h.worker.stats();
      expect(stats.pollDelayMs).toBeLessThanOrEqual(IDLE_POLL_CEILING_MS);
    } finally {
      await h.worker.stop();
    }
  });
});
