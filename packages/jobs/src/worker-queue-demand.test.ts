// `queue_demand`: what the worker HPA divides by a pod's capacity. `queue_depth` is ready-only, so
// a fleet holding 10 jobs read 0 and the chart's `ceil(0/100)` asked for `minReplicas` while those
// jobs ran: a scale-down mid-job, which is the same stop as a deploy.

import { beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, ctxOf, frozenClock, resetMetrics, SCALING_METRICS } from '@ultimat3/core';
import type { JobDriver, QueueStats } from './driver';
import { memoryJobDriver } from './driver-memory';
import { resetJobs } from './job';
import { recordQueueDemand } from './metrics';
import { jobWorker } from './worker';
import { createQueueDepthPublisher } from './worker-queue-depth';

const NOW = 1_700_000_000_000;
const INTERVAL_MS = 15_000;

const pointOf = (metric: string, queue: string): number | undefined =>
  collectMetrics()
    .metrics.find((one) => one.descriptor.name === metric)
    ?.points.find((point) => point.attributes['queue'] === queue)?.value;

const enqueue = (driver: JobDriver, queue: string, n: number): Promise<unknown> =>
  Promise.all(
    Array.from({ length: n }, (_, index) =>
      driver.enqueue({
        name: 'held',
        queue,
        input: {},
        idempotencyKey: `${queue}-${index}`,
        maxAttempts: 3,
      }),
    ),
  );

const claim = (driver: JobDriver, queue: string, limit: number, workerId: string) =>
  driver.claim({ queues: [queue], limit, workerId, visibilityTimeoutMs: 60_000 });

const stat = (queue: string, counts: Partial<QueueStats>): QueueStats => ({
  queue,
  ready: 0,
  delayed: 0,
  running: 0,
  suspended: 0,
  failed: 0,
  dead: 0,
  oldestReadyMs: 0,
  ...counts,
});

beforeEach(() => {
  resetMetrics();
  resetJobs();
});

describe('queue_demand', () => {
  test('10 held jobs are demand 10 and depth 0', async () => {
    const clock = frozenClock(NOW);
    const driver = memoryJobDriver({ clock });
    await enqueue(driver, 'banks', 10);
    await claim(driver, 'banks', 10, 'w1');
    await createQueueDepthPublisher({ driver, clock, workerId: 'w1' })();
    expect(pointOf('queue_demand', 'banks')).toBe(10);
    expect(pointOf('queue_depth', 'banks')).toBe(0);
  });

  test('held plus due; a future job and a paused queue are nobody’s demand', async () => {
    const clock = frozenClock(NOW);
    const driver = memoryJobDriver({ clock });
    await enqueue(driver, 'banks', 3);
    await claim(driver, 'banks', 1, 'w1');
    await driver.enqueue({
      name: 'later',
      queue: 'banks',
      input: {},
      idempotencyKey: 'later',
      maxAttempts: 3,
      runAt: NOW + 600_000,
    });
    await enqueue(driver, 'paused', 2);
    await driver.introspect?.pauseQueue('paused');
    expect(await driver.demand?.()).toEqual([{ queue: 'banks', demand: 3 }]);
  });

  test('a suspended run counts once it is due, as the claim would take it', async () => {
    const clock = frozenClock(NOW);
    const driver = memoryJobDriver({ clock });
    await enqueue(driver, 'banks', 1);
    const [held] = await claim(driver, 'banks', 1, 'w1');
    if (held === undefined) return expect.unreachable('the job was claimed');
    await driver.nack(held.id, {
      error: 'parked',
      delayMs: 1_000,
      countsAsAttempt: false,
      park: true,
      workerId: 'w1',
      claim: held.claim,
    });
    expect(await driver.demand?.()).toEqual([]);
    clock.advance(1_000);
    expect(await driver.demand?.()).toEqual([{ queue: 'banks', demand: 1 }]);
  });

  test('a draining worker’s runs are out, until its registry row lapses', async () => {
    const clock = frozenClock(NOW);
    const driver = memoryJobDriver({ clock });
    const announce = (id: string, draining: boolean) =>
      driver.introspect?.announceWorker(
        { id, host: id, startedAt: NOW, queues: ['banks'], concurrency: 4, inFlight: [], draining },
        30_000,
      );
    await enqueue(driver, 'banks', 3);
    await claim(driver, 'banks', 1, 'new');
    await claim(driver, 'banks', 2, 'old');
    await announce('new', false);
    await announce('old', true);
    expect(await driver.demand?.()).toEqual([{ queue: 'banks', demand: 1 }]);
    clock.advance(31_000);
    expect(await driver.demand?.()).toEqual([{ queue: 'banks', demand: 3 }]);
  });

  test('a queue leaving the answer is zeroed once, like its siblings', async () => {
    const clock = frozenClock(NOW);
    const rounds = [[{ queue: 'banks', demand: 4 }], [], []];
    let asks = 0;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      stats: () => Promise.resolve([stat('banks', { running: 1 })]),
      demand: () => Promise.resolve(rounds[asks++] ?? []),
    };
    const publish = createQueueDepthPublisher({ driver, clock, workerId: 'w1' });
    await publish();
    expect(pointOf('queue_demand', 'banks')).toBe(4);
    clock.advance(INTERVAL_MS);
    await publish();
    expect(pointOf('queue_demand', 'banks')).toBe(0);
    resetMetrics();
    clock.advance(INTERVAL_MS);
    await publish();
    expect(pointOf('queue_demand', 'banks')).toBeUndefined();
  });

  test('an idle queue costs no statement: stats() already proves nothing is demanded', async () => {
    let asks = 0;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      stats: () => Promise.resolve([stat('banks', { failed: 7, dead: 2, delayed: 4 })]),
      demand: () => {
        asks += 1;
        return Promise.resolve([]);
      },
    };
    await createQueueDepthPublisher({ driver, clock: frozenClock(NOW), workerId: 'w1' })();
    expect(asks).toBe(0);
  });

  test('a demand read that fails zeroes nothing and costs no tick', async () => {
    const clock = frozenClock(NOW);
    let fail = false;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      stats: () => Promise.resolve([stat('banks', { running: 1 })]),
      demand: () =>
        fail
          ? Promise.reject(new Error('the pool is gone'))
          : Promise.resolve([{ queue: 'banks', demand: 4 }]),
    };
    const publish = createQueueDepthPublisher({ driver, clock, workerId: 'w1' });
    await publish();
    fail = true;
    clock.advance(INTERVAL_MS);
    await publish();
    expect(pointOf('queue_demand', 'banks')).toBe(4);
  });

  test('is the series SCALING_METRICS names', () => {
    recordQueueDemand('banks', 1);
    expect(pointOf(String(SCALING_METRICS['queue-demand']), 'banks')).toBe(1);
  });
});

describe('a draining worker’s queue_demand', () => {
  test('is zero the moment it drains: a frozen gauge would pin max() for its whole retire', async () => {
    const clock = frozenClock(NOW);
    const driver = memoryJobDriver({ clock });
    await enqueue(driver, 'banks', 2);
    await claim(driver, 'banks', 2, 'someone-else');
    const worker = jobWorker({
      driver,
      queues: ['banks'],
      clock,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    expect(pointOf('queue_demand', 'banks')).toBe(2);
    await worker.stop('test');
    expect(pointOf('queue_demand', 'banks')).toBe(0);
  });

  test('a round in flight when the drain lands does not republish', async () => {
    const clock = frozenClock(NOW);
    const asked = Promise.withResolvers<void>();
    let answer: (rows: readonly { queue: string; demand: number }[]) => void = () => undefined;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      stats: () => Promise.resolve([stat('banks', { running: 1 })]),
      demand: () =>
        new Promise((resolve) => {
          answer = resolve;
          asked.resolve();
        }),
    };
    const publish = createQueueDepthPublisher({ driver, clock, workerId: 'w1' });
    const round = publish();
    await asked.promise;
    publish.retractDemand();
    answer([{ queue: 'banks', demand: 9 }]);
    await round;
    expect(pointOf('queue_demand', 'banks')).toBeUndefined();
  });

  test('a drain landing while stats() is still out does not republish either', async () => {
    const clock = frozenClock(NOW);
    const asked = Promise.withResolvers<void>();
    let answer: (rows: readonly QueueStats[]) => void = () => undefined;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      stats: () =>
        new Promise((resolve) => {
          answer = resolve;
          asked.resolve();
        }),
      demand: () => Promise.resolve([{ queue: 'banks', demand: 8 }]),
    };
    const publish = createQueueDepthPublisher({ driver, clock, workerId: 'w1' });
    const round = publish();
    await asked.promise;
    publish.retractDemand();
    answer([stat('banks', { running: 8 })]);
    await round;
    expect(pointOf('queue_demand', 'banks')).toBeUndefined();
  });
});
