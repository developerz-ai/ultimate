// The claim loop's timer, through a real worker: what cuts a backed-off wait short, and that a
// wake never forks the loop. The waits here are real because the timer is — each is bounded by
// the worker's own floor (25 ms), and the assertion is the gap a regression would stretch.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { createContext } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { resetJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { setWakeLive, signalEnqueued } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { createWorker } from './worker';
import type { Worker } from './worker-types';

afterEach(() => {
  resetJobs();
  resetJobDriver();
  setWakeLive(false);
});

const context = () => createContext({ role: 'worker', buildId: 'test' });

/** The preload freezes `Date`; a retry's due time needs a clock that moves with the timers. */
const moving: Clock = {
  now: () => new Date(1_790_000_000_000 + performance.now()),
  monotonic: () => performance.now(),
};

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real time, bounded: fails rather than hangs when the loop never gets there. */
async function until(condition: () => boolean | Promise<boolean>, budgetMs = 4_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await Bun.sleep(2);
  }
}

const backedOffTo = (worker: Worker, ms: number) => async (): Promise<boolean> =>
  (await worker.stats()).pollDelayMs >= ms;

const enqueue = (driver: JobDriver, name: string, item: string, queue = 'default') =>
  driver.enqueue({
    name,
    queue,
    input: { item },
    idempotencyKey: `loop:${item}`,
    maxAttempts: 3,
  });

describe('the claim loop', () => {
  test('a wake landing on a pass in flight asks for ONE more pass, never a second loop', async () => {
    const driver = createMemoryDriver();
    let inFlight = 0;
    let most = 0;
    let claims = 0;
    const gate = deferred();
    const slow: JobDriver = {
      ...driver,
      async claim(options) {
        claims += 1;
        inFlight += 1;
        most = Math.max(most, inFlight);
        // The first claim is held open: the wakes below land while it is on the wire.
        if (claims === 1) await gate.promise;
        try {
          return await driver.claim(options);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const worker = createWorker({
      driver: slow,
      pollIntervalMs: 25,
      idlePollMaxMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await until(() => claims === 1);
      signalEnqueued();
      signalEnqueued('default');
      await Bun.sleep(40);
      // A second chain would have opened its own claim beside the one held open.
      expect(claims).toBe(1);
      gate.resolve();
      // The news arrived after that claim's snapshot: one more pass, at once.
      await until(() => claims === 2, 200);
      await Bun.sleep(120);
      expect(most).toBe(1);
      // One loop: 25 and 50 ms after the second pass. Two loops would have doubled it.
      expect(claims).toBeLessThanOrEqual(4);
    } finally {
      // Before the stop: a failed assertion above must not leave it waiting on the held claim.
      gate.resolve();
      await worker.stop();
    }
  });

  test('a wake naming a queue this worker does not serve changes nothing', async () => {
    const driver = createMemoryDriver();
    const worker = createWorker({
      driver,
      queues: ['mail'],
      pollIntervalMs: 25,
      idlePollMaxMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await until(backedOffTo(worker, 200));
      const before = (await worker.stats()).pollDelayMs;
      signalEnqueued('default');
      expect((await worker.stats()).pollDelayMs).toBe(before);
      signalEnqueued('mail');
      expect((await worker.stats()).pollDelayMs).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  test('a slot coming free is refilled at once, not at the end of the backed-off wait', async () => {
    const driver = createMemoryDriver();
    const first = deferred();
    const started: string[] = [];
    let secondAt = 0;
    const handle = itemJob({
      async run({ input }) {
        started.push(input.item);
        if (input.item === 'long') await first.promise;
        else secondAt = performance.now();
      },
    });
    const worker = createWorker({
      driver,
      concurrency: 1,
      pollIntervalMs: 25,
      idlePollMaxMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    await enqueue(driver, handle.name, 'long');
    worker.start();
    try {
      await until(() => started.length === 1);
      // Full: every pass asks for nothing, so the loop backs off while it holds the job.
      await until(backedOffTo(worker, 400));
      await enqueue(driver, handle.name, 'behind');
      const released = performance.now();
      first.resolve();
      await until(() => started.length === 2, 1_000);
      // Without the kick this is whatever is left of a 400 ms+ wait.
      expect(secondAt - released).toBeLessThan(150);
    } finally {
      await worker.stop();
    }
  });

  test('a retry is picked up when it falls due, not at the next backed-off poll', async () => {
    const driver = createMemoryDriver({ clock: moving });
    const attempts: number[] = [];
    const handle = itemJob({
      retry: { attempts: 2, backoff: 'fixed', delay: 450, jitter: false },
      run() {
        attempts.push(performance.now());
        if (attempts.length === 1) return Promise.reject(new Error('first attempt fails'));
        return Promise.resolve();
      },
    });
    const worker = createWorker({
      driver,
      clock: moving,
      pollIntervalMs: 25,
      idlePollMaxMs: 60_000,
      context,
      drainOnShutdown: false,
    });
    await enqueue(driver, handle.name, 'retried');
    worker.start();
    try {
      await until(() => attempts.length === 2, 3_000);
      const gap = (attempts[1] ?? 0) - (attempts[0] ?? 0);
      // Due at 450 ms. The polls alone land at 25, 75, 175, 375 and then 775 ms after the
      // failure, so without the timer the retry is 325 ms late.
      expect(gap).toBeGreaterThanOrEqual(445);
      expect(gap).toBeLessThan(650);
    } finally {
      await worker.stop();
    }
  });
});
