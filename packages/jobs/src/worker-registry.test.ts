// A worker's registry row across its stop. The first announce is fired at start and each later one
// by the renewal interval, and none was held: a `stop()` that forgot the row while an announce was
// still on the wire had the announce land AFTER it, and a stopped worker stayed listed as serving
// for a whole TTL.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import type { WorkerAnnouncement } from './introspection';
import { startWorkerRegistry } from './worker-registry';

/** A registry whose announce is on the wire until the test lets it land. */
function slowRegistry() {
  const rows = new Map<string, WorkerAnnouncement>();
  const landing: (() => void)[] = [];
  const order: string[] = [];
  const driver = {
    name: 'fake',
    introspect: {
      announceWorker(worker: WorkerAnnouncement) {
        return new Promise<void>((resolve) => {
          landing.push(() => {
            rows.set(worker.id, worker);
            order.push('announce');
            resolve();
          });
        });
      },
      forgetWorker(id: string) {
        rows.delete(id);
        order.push('forget');
        return Promise.resolve();
      },
    },
  } as unknown as JobDriver;
  return { driver, rows, landing, order };
}

const start = (driver: JobDriver, ticks: (() => void)[] = []) =>
  startWorkerRegistry({
    driver,
    workerId: 'w1',
    host: 'pod-1',
    queues: ['default'],
    concurrency: 4,
    inFlight: () => [],
    ttlMs: 30_000,
    intervalMs: 10_000,
    schedule: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
  });

describe('a worker that stops is not listed', () => {
  test('stop() forgets AFTER the announce still on the wire, never under it', async () => {
    const { driver, rows, landing, order } = slowRegistry();
    const registration = start(driver);
    const stopped = registration.stop();
    await new Promise((resolve) => setImmediate(resolve));
    for (const land of landing) land();
    await stopped;

    expect(order).toEqual(['announce', 'forget']);
    expect([...rows.keys()]).toEqual([]);
  });

  test('a heartbeat announce in flight is waited out the same way', async () => {
    const { driver, rows, landing, order } = slowRegistry();
    const ticks: (() => void)[] = [];
    const registration = start(driver, ticks);
    landing.shift()?.();
    ticks[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(landing).toHaveLength(1);

    const stopped = registration.stop();
    await new Promise((resolve) => setImmediate(resolve));
    landing.shift()?.();
    await stopped;

    expect(order).toEqual(['announce', 'announce', 'forget']);
    expect([...rows.keys()]).toEqual([]);
  });

  test('an announce that FAILS does not hold the stop, and the row is still forgotten', async () => {
    const order: string[] = [];
    const driver = {
      name: 'fake',
      introspect: {
        announceWorker: () => Promise.reject(new Error('pool closed')),
        forgetWorker() {
          order.push('forget');
          return Promise.resolve();
        },
      },
    } as unknown as JobDriver;
    await start(driver).stop();
    expect(order).toEqual(['forget']);
  });
});
