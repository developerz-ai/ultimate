// A backlog drains at the speed of its jobs, never one poll interval per batch: a pass that came
// back FULL means more is waiting, so a slot freeing behind it claims at once. The floor here is a
// minute, so a regression is not "slower" but a timed-out `until` (bench: 31 claims/s at 250 ms).

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { signalEnqueued } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { jobWorker } from './worker';

afterEach(() => {
  resetJobs();
  resetJobDriver();
});

const context = () => ctxOf({ role: 'worker', buildId: 'test' });

/** Real time, bounded: fails rather than hangs when the loop never gets there. */
async function until(condition: () => Promise<boolean>, budgetMs: number): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) expect.unreachable('the backlog did not drain in time');
    await new Promise<void>((done) => setImmediate(done));
  }
}

const turns = async (count: number): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

const BACKLOG = 40;
const SLOTS = 8;

describe('the claim loop under a backlog', () => {
  test('N no-op jobs drain in about N/slots passes, with no floor-long wait between them', async () => {
    const inner = memoryJobDriver();
    let claims = 0;
    const driver: JobDriver = {
      ...inner,
      claim(options) {
        claims += 1;
        return inner.claim(options);
      },
    };
    const handle = itemJob({ run: () => Promise.resolve() });
    for (let n = 0; n < BACKLOG; n += 1) {
      await driver.enqueue({
        name: handle.name,
        queue: 'default',
        input: { item: `b${n}` },
        idempotencyKey: `backlog:${n}`,
        maxAttempts: 1,
      });
    }
    const worker = jobWorker({
      driver,
      concurrency: SLOTS,
      pollIntervalMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    const started = performance.now();
    worker.start();
    try {
      // The first pass is armed at the floor too: kick it, as an enqueue's wake would.
      await worker.tick();
      await until(async () => (await worker.stats()).processed >= BACKLOG, 3_000);
      expect(performance.now() - started).toBeLessThan(3_000);
      // Passes, not timers: one per freed slot at most, never a spin.
      expect(claims).toBeLessThanOrEqual(BACKLOG + 2);
      expect(claims).toBeGreaterThanOrEqual(Math.ceil(BACKLOG / SLOTS));
    } finally {
      await worker.stop();
    }
  });

  test('a pass whose rows a cap sent back is not a backlog: a completion does not re-claim them', async () => {
    const inner = memoryJobDriver();
    let claims = 0;
    const driver: JobDriver = {
      ...inner,
      claim(options) {
        claims += 1;
        return inner.claim(options);
      },
    };
    let release = (): void => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    // One at a time: a pass claims SLOTS rows, admits ONE, and sends the rest back. The admitted
    // run is held until the pass is over, so its completion is the kick under test.
    const handle = itemJob({ run: () => gate, concurrency: 1 });
    for (let n = 0; n < SLOTS; n += 1) {
      await driver.enqueue({
        name: handle.name,
        queue: 'default',
        input: { item: `c${n}` },
        idempotencyKey: `capped:${n}`,
        maxAttempts: 3,
      });
    }
    const worker = jobWorker({
      driver,
      concurrency: SLOTS,
      pollIntervalMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      // The loop's own pass, woken as an enqueue wakes it — `tick()` would wait for the run.
      signalEnqueued('default');
      await until(async () => claims === 1 && (await worker.stats()).inFlight === 1, 3_000);
      await turns(20);
      release();
      await until(async () => (await worker.stats()).processed === 1, 3_000);
      await turns(5);
      // A kick sets the wait to 0 at once and its pass claims a moment later: either is the bug.
      expect((await worker.stats()).pollDelayMs).toBe(60_000);
      expect(claims).toBe(1);
    } finally {
      release();
      await worker.stop();
    }
  });
});
