// A worker registry's two quiet paths: a driver with no introspection has no registry to appear
// in, so nothing is announced and both verbs resolve; and a forget the store refuses is logged,
// never thrown, so a stopping worker is not held up by its own row.

import { describe, expect, test } from 'bun:test';
import { setLogSink } from '@ultimat3/core';
import type { JobDriver } from './driver';
import type { WorkerAnnouncement } from './introspection';
import { startWorkerRegistry } from './worker-registry';

const options = (driver: JobDriver, scheduled: (() => void)[]) => ({
  driver,
  workerId: 'w-edge',
  host: 'pod-1',
  queues: ['default'],
  concurrency: 1,
  inFlight: () => [],
  ttlMs: 30_000,
  intervalMs: 10_000,
  schedule: (tick: () => void) => {
    scheduled.push(tick);
    return () => undefined;
  },
});

describe('startWorkerRegistry', () => {
  test('a driver with no introspection announces nothing and arms no renewal', async () => {
    const scheduled: (() => void)[] = [];
    const driver = { name: 'bare' } as unknown as JobDriver;
    const registration = startWorkerRegistry(options(driver, scheduled));
    await registration.draining();
    await registration.stop();
    expect(scheduled).toEqual([]);
  });

  test('a forget the store refuses is logged as forget-failed, and stop still resolves', async () => {
    const announced: WorkerAnnouncement[] = [];
    const driver = {
      name: 'refusing',
      introspect: {
        announceWorker: (worker: WorkerAnnouncement) => {
          announced.push(worker);
          return Promise.resolve();
        },
        forgetWorker: () => Promise.reject(new TypeError('the store went away')),
      },
    } as unknown as JobDriver;
    const lines: { msg?: string; workerId?: string; error?: string }[] = [];
    const previous = setLogSink((line) => {
      lines.push(JSON.parse(line) as { msg?: string; workerId?: string; error?: string });
    });
    try {
      const registration = startWorkerRegistry(options(driver, []));
      await registration.stop();
    } finally {
      setLogSink(previous);
    }
    expect(announced.map((worker) => worker.id)).toEqual(['w-edge']);
    const failed = lines.filter((line) => line.msg === 'jobs.worker.forget-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.workerId).toBe('w-edge');
    expect(failed[0]?.error).toContain('the store went away');
  });
});
