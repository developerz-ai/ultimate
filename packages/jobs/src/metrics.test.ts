// J8: queue observability stopped one metric short of alertable. `oldestReadyMs` is documented as
// "the number that decides autoscaling", computed in SQL, surfaced in `inspectQueues` — and never
// published as a series. And `jobs_total{outcome="dead"}` is a counter, so a dead-letter queue
// that filled overnight and stopped growing pages nobody.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, createContext, resetMetrics } from '@ultimat3/core';
import { createMemoryDriver } from './driver-memory';
import { resetJobs } from './job';
import { createWorker } from './worker';

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetJobs();
  resetMetrics();
});

const gauge = (name: string, queue: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === name)
    ?.points.find((point) => point.attributes['queue'] === queue)?.value;

describe('the alertable queue gauges', () => {
  test('the worker publishes oldest-ready and dead-count alongside depth', async () => {
    const at = 1_000_000;
    const clock = { now: () => new Date(at), monotonic: () => at };
    const driver = createMemoryDriver({ clock });
    await driver.enqueue({
      name: 'stuck',
      queue: 'payments',
      input: {},
      idempotencyKey: 'stuck:1',
      maxAttempts: 1,
      runAt: at - 600_000,
    });

    const worker = createWorker({
      driver,
      clock,
      queues: ['payments'],
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    await worker.stop('test');

    // "page if the oldest job in payments is older than 5 minutes" — the alert every queue team
    // writes, and the one there was no series for.
    expect(gauge('queue_oldest_ready_seconds', 'payments')).toBe(600);
    // A gauge and not a rate: a DLQ that stopped growing still reads non-zero.
    expect(gauge('queue_dead_jobs', 'payments')).toBe(0);
    expect(gauge('queue_depth', 'payments')).toBeDefined();
  });

  test('seconds, not milliseconds — every Prometheus duration is seconds', async () => {
    const at = 2_000_000;
    const clock = { now: () => new Date(at), monotonic: () => at };
    const driver = createMemoryDriver({ clock });
    await driver.enqueue({
      name: 'fresh',
      queue: 'default',
      input: {},
      idempotencyKey: 'fresh:1',
      maxAttempts: 1,
      runAt: at - 1_500,
    });
    const worker = createWorker({
      driver,
      clock,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    await worker.stop('test');

    expect(gauge('queue_oldest_ready_seconds', 'default')).toBe(1.5);
  });
});
