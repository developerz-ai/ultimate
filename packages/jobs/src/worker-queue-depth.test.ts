// A queue that leaves `stats()` must leave the gauges at zero. A gauge keeps the last value it was
// given, and `SQL_STATS` lists a queue only while it holds a row it counts, so a queue that drained
// to `done` would otherwise read its final backlog forever and hold the worker HPA scaled out.

import { beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, frozenClock, resetMetrics } from '@ultimat3/core';
import type { QueueStats } from './driver';
import { memoryJobDriver } from './driver-memory';
import { createQueueDepthPublisher } from './worker-queue-depth';

const stat = (queue: string, ready: number, dead: number, oldestReadyMs: number): QueueStats => ({
  queue,
  ready,
  delayed: 0,
  running: 0,
  suspended: 0,
  failed: 0,
  dead,
  oldestReadyMs,
});

const pointOf = (metric: string, queue: string): number | undefined =>
  collectMetrics()
    .metrics.find((one) => one.descriptor.name === metric)
    ?.points.find((point) => point.attributes['queue'] === queue)?.value;

beforeEach(() => {
  resetMetrics();
});

describe('the queue depth publisher', () => {
  test('a queue the driver stops reporting is published at zero, once', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const rounds: (readonly QueueStats[])[] = [
      [stat('mail', 5, 2, 90_000), stat('default', 1, 0, 0)],
      [stat('default', 1, 0, 0)],
      [stat('default', 1, 0, 0)],
    ];
    let reads = 0;
    const publish = createQueueDepthPublisher({
      driver: { ...memoryJobDriver(), stats: () => Promise.resolve(rounds[reads++] ?? []) },
      clock,
      workerId: 'w1',
    });

    await publish();
    expect(pointOf('queue_depth', 'mail')).toBe(5);
    expect(pointOf('queue_dead_jobs', 'mail')).toBe(2);
    expect(pointOf('queue_oldest_ready_seconds', 'mail')).toBe(90);

    clock.advance(15_000);
    await publish();
    expect(pointOf('queue_depth', 'mail')).toBe(0);
    expect(pointOf('queue_dead_jobs', 'mail')).toBe(0);
    expect(pointOf('queue_oldest_ready_seconds', 'mail')).toBe(0);
    expect(pointOf('queue_depth', 'default')).toBe(1);

    // Zeroed once and then forgotten: the publisher holds only the queues of its last round.
    resetMetrics();
    clock.advance(15_000);
    await publish();
    expect(pointOf('queue_depth', 'mail')).toBeUndefined();
    expect(pointOf('queue_depth', 'default')).toBe(1);
  });

  test('a round that cannot be read zeroes nothing', async () => {
    const clock = frozenClock(1_700_000_000_000);
    let fail = false;
    const publish = createQueueDepthPublisher({
      driver: {
        ...memoryJobDriver(),
        stats: () =>
          fail
            ? Promise.reject(new Error('connection reset'))
            : Promise.resolve([stat('mail', 4, 0, 0)]),
      },
      clock,
      workerId: 'w1',
    });
    await publish();
    fail = true;
    clock.advance(15_000);
    await publish();
    // An unmeasured queue is not an empty one: the last reading stands until a read succeeds.
    expect(pointOf('queue_depth', 'mail')).toBe(4);
  });
});
