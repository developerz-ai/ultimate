// The step-replay guarantee, proven over a REAL worker: `start()`/`stop()` and the real poll
// loop, not `tick()` driven by hand. A step's persisted output must survive both kinds of restart
// a queue actually causes — a failed attempt retried, and a suspended run resumed — and in both
// cases the steps that already finished must not run again.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

/** Polls a real worker's own loop rather than a fake timer, so this proves the shipped path. */
async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

afterEach(() => {
  resetJobs();
});

describe('a completed step survives a real retry', () => {
  test('the failed step re-runs; the one before it does not', async () => {
    const chargeCalls: number[] = [];
    const notifyCalls: number[] = [];
    const clock = frozenClock(0);
    const driver = createMemoryDriver({ clock });

    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'chargeAndNotify',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `charge:${n}`,
      // Fixed, zero-delay retry: the second attempt is claimable on the very next real poll,
      // with nothing here depending on real elapsed time.
      retry: { attempts: 2, backoff: 'fixed', delay: 0, jitter: false },
      run: async ({ step, attempt }) => {
        await step.run('charge', () => {
          chargeCalls.push(attempt);
          return 'charged';
        });
        await step.run('notify', () => {
          notifyCalls.push(attempt);
          if (attempt === 1) throw new Error('smtp unavailable');
          return 'notified';
        });
      },
    });

    await driver.enqueue({
      name: 'chargeAndNotify',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: handle.idempotencyKeyFor({ n: 1 }),
      maxAttempts: handle.retry.attempts,
    });

    const worker = createWorker({
      driver,
      context,
      clock,
      drainOnShutdown: false,
      pollIntervalMs: 5,
    });
    worker.start();
    let jobs: readonly { readonly runId: string }[] = [];
    try {
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      }, 'job reaches done');
      // Captured before stop(): `worker.stop()` closes the driver, and the memory driver's
      // `close()` clears its jobs map — so this must be read while the worker is still up.
      jobs = (await driver.introspect?.list({ state: 'done' })) ?? [];
    } finally {
      await worker.stop('test-end');
    }

    // Two attempts happened, but `charge` paid its price exactly once — attempt 2 replayed it
    // from storage rather than re-running a step that already succeeded.
    expect(chargeCalls).toEqual([1]);
    expect(notifyCalls).toEqual([1, 2]);

    // The step store is untouched by `close()` — only the queue rows are — so this read is safe
    // after the worker has stopped.
    const steps = await driver.steps.list(jobs[0]?.runId ?? '');
    const charge = steps.find((step) => step.name === 'charge');
    const notify = steps.find((step) => step.name === 'notify');
    expect(charge).toMatchObject({ status: 'completed', attempts: 1 });
    expect(notify).toMatchObject({ status: 'completed', attempts: 2 });
  });
});

describe('a suspended step resumes without re-running what already ran', () => {
  test('step.sleep parks the run; the real worker picks it back up after the clock catches up', async () => {
    const stepOneCalls: number[] = [];
    const stepTwoCalls: number[] = [];
    const clock = frozenClock(0);
    const driver = createMemoryDriver({ clock });

    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'sleepAndResume',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `sleep:${n}`,
      retry: { attempts: 2, backoff: 'fixed', delay: 0, jitter: false },
      run: async ({ step, attempt }) => {
        await step.run('step1', () => {
          stepOneCalls.push(attempt);
          return 'one';
        });
        await step.sleep('10s');
        await step.run('step2', () => {
          stepTwoCalls.push(attempt);
          return 'two';
        });
      },
    });

    await driver.enqueue({
      name: 'sleepAndResume',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: handle.idempotencyKeyFor({ n: 1 }),
      maxAttempts: handle.retry.attempts,
    });

    const worker = createWorker({
      driver,
      context,
      clock,
      drainOnShutdown: false,
      pollIntervalMs: 5,
    });
    worker.start();
    try {
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ name: 'sleepAndResume' })) ?? [];
        if (record === undefined) return false;
        const steps = await driver.steps.list(record.runId);
        return steps.some((s) => s.name.startsWith('sleep:') && s.status === 'sleeping');
      }, 'run suspended on the sleep step');

      expect(stepOneCalls).toEqual([1]);
      expect(stepTwoCalls).toEqual([]);

      // The only legal way for time to pass here: move the clock both the driver and the worker
      // share, then let the real poll loop notice the row is claimable again.
      clock.advance(10_001);

      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      }, 'run resumes and completes');
    } finally {
      await worker.stop('test-end');
    }

    expect(stepOneCalls).toEqual([1]);
    expect(stepTwoCalls).toEqual([1]);
  });
});
