// The `queue_depth` gauge `docker/helm`'s worker HPA scales on. The worker is the only process
// that reads its own queue, so it is the only thing that can publish the number — and it must
// publish it without letting the read cost a tick or repeat itself sixty times a scrape.

import { beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, createContext, resetMetrics } from '@ultimat3/core';
import type { ClaimedJob, JobDriver, QueueStats } from './driver';
import { createMemoryDriver } from './driver-memory';
import { createWorker } from './worker';

const queue = (name: string, ready: number): QueueStats => ({
  queue: name,
  ready,
  delayed: 0,
  running: 0,
  suspended: 0,
  dead: 0,
  oldestReadyMs: 0,
});

interface CountingDriver {
  readonly driver: JobDriver;
  calls(): { stats: number; claim: number };
}

/** The memory driver's real `steps` store with the two methods under test swapped out. */
function countingDriver(stats: () => Promise<readonly QueueStats[]>): CountingDriver {
  let statsCalls = 0;
  let claimCalls = 0;
  const base = createMemoryDriver();
  return {
    driver: {
      ...base,
      async stats(): Promise<readonly QueueStats[]> {
        statsCalls += 1;
        return await stats();
      },
      async claim(): Promise<readonly ClaimedJob[]> {
        claimCalls += 1;
        return [];
      },
    },
    calls: () => ({ stats: statsCalls, claim: claimCalls }),
  };
}

const depthOf = (name: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'queue_depth')
    ?.points.find((point) => point.attributes['queue'] === name)?.value;

const worker = (driver: JobDriver) =>
  createWorker({ driver, context: () => createContext({ role: 'worker', buildId: 'test' }) });

beforeEach(() => {
  resetMetrics();
});

describe('the worker publishes queue depth', () => {
  test('one series per queue the driver reports, labelled by queue', async () => {
    const counting = countingDriver(async () => [queue('default', 41), queue('emails', 7)]);
    await worker(counting.driver).tick();

    expect(depthOf('default')).toBe(41);
    // Every queue, not only the ones this process serves: depth is the queue's fact, and a queue
    // no pod published is a queue no autoscaler can see.
    expect(depthOf('emails')).toBe(7);
  });

  test('claimable only — a job parked until Tuesday is not backlog', async () => {
    const counting = countingDriver(async () => [
      { ...queue('default', 2), delayed: 900, suspended: 40, dead: 5 },
    ]);
    await worker(counting.driver).tick();

    expect(depthOf('default')).toBe(2);
  });

  test('the read is throttled, so polling does not multiply the queue read load', async () => {
    const counting = countingDriver(async () => [queue('default', 3)]);
    const running = worker(counting.driver);
    await running.tick();
    await running.tick();
    await running.tick();

    expect(counting.calls()).toEqual({ stats: 1, claim: 3 });
  });

  test('a queue that cannot be measured is still worked', async () => {
    const counting = countingDriver(() => Promise.reject(new Error('connection reset')));
    await worker(counting.driver).tick();

    // Instrumentation is never allowed to stop the claim loop; the tick that could not read the
    // depth still asked for work.
    expect(counting.calls().claim).toBe(1);
    expect(depthOf('default')).toBeUndefined();
  });
});
