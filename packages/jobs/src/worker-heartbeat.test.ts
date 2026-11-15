// The worker's claim loop stamps its heartbeat (`loop-heartbeat.ts`): a claim that never returns
// — the event loop alive, the claim loop stuck — is stale within the bound, a worker RESTING on a
// live wake stays fresh however long it rests, and a stopped worker is not judged at all.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive } from './enqueue-signal';
import { useFakeTime } from './fake-time-fixture';
import { resetJobs } from './job';
import { LIVENESS_FLOOR_MS, staleLoops } from './loop-heartbeat';
import { jobWorker } from './worker';

afterEach(() => {
  resetJobs();
  resetJobDriver();
  setWakeLive(false);
});

const context = () => ctxOf({ role: 'worker', buildId: 'test' });
const time = useFakeTime();

describe('unit · worker heartbeat', () => {
  test('a claim that never returns turns the worker stale within its bound', async () => {
    const driver = memoryJobDriver();
    let claims = 0;
    let release = (): void => undefined;
    const wedged: JobDriver = {
      ...driver,
      async claim(options) {
        claims += 1;
        if (claims === 2) await new Promise<void>((done) => (release = done));
        return driver.claim(options);
      },
    };
    const worker = jobWorker({
      driver: wedged,
      pollIntervalMs: 25,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await time.until(() => claims === 2);
      await time.advance(LIVENESS_FLOOR_MS - 1_000, 1_000);
      expect(staleLoops()).toEqual([]);
      await time.advance(2_000, 1_000);
      expect(staleLoops().map((loop) => [loop.name, loop.reason])).toEqual([['jobWorker', 'held']]);
    } finally {
      release();
      await worker.stop();
    }
    expect(staleLoops()).toEqual([]);
  });

  test('an idle worker resting on a live wake stays fresh for minutes', async () => {
    setWakeLive(true);
    const worker = jobWorker({
      driver: memoryJobDriver(),
      pollIntervalMs: 25,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await time.advance(5 * 60_000, 500);
      // It did rest: the wait in hand is the 60 s rest, not a 5 s poll.
      expect((await worker.stats()).pollDelayMs).toBeGreaterThan(5_000);
      expect(staleLoops()).toEqual([]);
    } finally {
      await worker.stop();
    }
  });
});
