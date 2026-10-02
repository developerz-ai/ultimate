// `createWorker({ schedule })` is the ONE seam every renewal a worker arms runs on — the registry
// row's here, the lease's and the fleet slot's per run. A renewal wired past it would be a real
// interval inside the `runJobs` fixture, ticking on the wall clock under every job test.

import { describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import { createMemoryDriver } from './driver-memory';
import type { IntervalScheduler } from './renewal-timer';
import { createWorker } from './worker';

describe('unit · the worker renews on the scheduler it is handed', () => {
  test('the registry row is announced on the injected seam, and stop() disarms it', async () => {
    const armed = new Map<() => void, number>();
    const schedule: IntervalScheduler = (tick, intervalMs) => {
      armed.set(tick, intervalMs);
      return () => {
        armed.delete(tick);
      };
    };
    const worker = createWorker({
      driver: createMemoryDriver(),
      workerId: 'scheduled-worker',
      heartbeatIntervalMs: 7_000,
      drainOnShutdown: false,
      schedule,
      context: () => createContext({ role: 'worker' }),
    });

    worker.start();
    expect([...armed.values()]).toEqual([7_000]);
    await worker.stop();
    expect(armed.size).toBe(0);
  });
});
