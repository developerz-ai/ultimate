// What the claim loop must NOT wait for. A pass used to end on `Promise.allSettled([...inFlight])`
// — every job the whole worker held, from every queue — so one slow job froze the pool: no slot
// refilled and no other queue was asked until the slowest member of the batch finished. A slot
// belongs to its own job, and it is free the moment that job settles.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimOptions, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface Gate {
  readonly passed: Promise<void>;
  open(): void;
}

/** A promise the test opens by hand — the only way to park a job inside one exact await. */
function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

const enqueue = (driver: JobDriver, name: string, queue: string): Promise<unknown> =>
  driver.enqueue({ name, queue, input: {}, idempotencyKey: `${name}:1`, maxAttempts: 1 });

afterEach(() => {
  resetJobs();
});

describe('a slot refills when its own job settles, not when the batch does', () => {
  test('a later pass finishes a job while an earlier one is still parked', async () => {
    const parked = gate();
    const started = gate();
    let slowEnded = false;
    job({
      name: 'slowJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'slow:1',
      retry: { attempts: 1, jitter: false },
      run: async () => {
        started.open();
        await parked.passed;
        slowEnded = true;
      },
    });
    job({
      name: 'quickJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'quick:1',
      retry: { attempts: 1, jitter: false },
      run: () => Promise.resolve(),
    });

    const driver = createMemoryDriver();
    const worker = createWorker({ driver, concurrency: 2, context, drainOnShutdown: false });
    await enqueue(driver, 'slowJob', 'default');

    const first = worker.tick();
    await started.passed;
    await enqueue(driver, 'quickJob', 'default');

    // The assertion is that this resolves at all: before the fix it awaited every in-flight job in
    // the worker, so the quick job's own pass could not end until the parked one did.
    const second = await worker.tick();

    expect(second.map((execution) => execution.job)).toEqual(['quickJob']);
    expect(slowEnded).toBe(false);

    parked.open();
    // And a pass reports the jobs IT started — never another pass's.
    expect((await first).map((execution) => execution.job)).toEqual(['slowJob']);
    expect(slowEnded).toBe(true);
  });

  test('a long job on one queue leaves the other queues claiming', async () => {
    const parked = gate();
    const started = gate();
    const asked: string[] = [];
    job({
      name: 'importJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'import:1',
      retry: { attempts: 1, jitter: false },
      run: async () => {
        started.open();
        await parked.passed;
      },
    });
    job({
      name: 'emailJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'email:1',
      retry: { attempts: 1, jitter: false },
      run: () => Promise.resolve(),
    });

    const base = createMemoryDriver();
    const driver: JobDriver = {
      ...base,
      claim(options: ClaimOptions) {
        asked.push(...options.queues);
        return base.claim(options);
      },
    };
    const worker = createWorker({
      driver,
      queues: ['imports', 'emails'],
      concurrency: 1,
      context,
      drainOnShutdown: false,
    });
    await enqueue(driver, 'importJob', 'imports');

    const first = worker.tick();
    await started.passed;
    await enqueue(driver, 'emailJob', 'emails');
    const second = await worker.tick();

    expect(second.map((execution) => execution.job)).toEqual(['emailJob']);
    // The saturated queue costs nothing: its one slot is held, so the driver is never asked for it.
    expect(asked).toEqual(['imports', 'emails', 'emails']);

    parked.open();
    await first;
  });

  test('refill is bounded by the pool, not by luck', async () => {
    const parked = gate();
    const started = gate();
    const running: string[] = [];
    for (const name of ['jobA', 'jobB']) {
      job({
        name,
        input: passthrough<Record<string, never>>(),
        idempotencyKey: () => `${name}:1`,
        retry: { attempts: 1, jitter: false },
        run: async () => {
          running.push(name);
          started.open();
          await parked.passed;
        },
      });
    }

    const driver = createMemoryDriver();
    const worker = createWorker({ driver, concurrency: 1, context, drainOnShutdown: false });
    await enqueue(driver, 'jobA', 'default');
    await enqueue(driver, 'jobB', 'default');

    const first = worker.tick();
    await started.passed;
    // One slot, one job: a loop that no longer waits for the batch must still not overrun the pool.
    expect(await worker.tick()).toEqual([]);
    expect(running).toEqual(['jobA']);

    parked.open();
    await first;
    expect((await worker.tick()).map((execution) => execution.job)).toEqual(['jobB']);
  });
});
