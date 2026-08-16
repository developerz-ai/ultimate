// The drain's ordering contract: `stop()` waits out the claim round it is racing before it
// closes the driver, and a close that throws leaves the worker stopped rather than pinned
// mid-drain. A driver closed under a job that started one microtask later is a job finishing on
// a dead connection — the ack never lands, the lease expires, and the queue delivers it twice.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, ClaimOptions, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

/** Minimal Standard Schema, so this file does not depend on the shipped provider's surface. */
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
  /** Resolves when `open()` is called. */
  readonly passed: Promise<void>;
  open(): void;
}

/** A promise the test opens by hand — the only way to park a worker inside one exact await. */
function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

afterEach(() => {
  resetJobs();
});

describe('stop() waits out the round it races', () => {
  test('a job claimed after the drain began still finishes before the driver closes', async () => {
    const trace: string[] = [];
    const claiming = gate();
    const entered = gate();
    const base = createMemoryDriver();
    const driver: JobDriver = {
      ...base,
      async claim(options: ClaimOptions): Promise<readonly ClaimedJob[]> {
        entered.open();
        // Parked here, this round holds nothing yet: `inFlight` is empty and a drain that only
        // snapshots `inFlight` sees a worker with nothing to wait for.
        await claiming.passed;
        return await base.claim(options);
      },
      async close(): Promise<void> {
        trace.push('close');
        await base.close();
      },
    };

    const running = gate();
    job<{ n: number }>({
      tenant: 'none',
      name: 'drainedJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `drained:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async () => {
        trace.push('job:start');
        await running.passed;
        trace.push('job:end');
      },
    });
    await driver.enqueue({
      name: 'drainedJob',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'drained:1',
      maxAttempts: 1,
    });

    const worker = createWorker({ driver, context, drainOnShutdown: false });
    const round = worker.tick();
    await entered.passed;

    // The race: the round is inside `claim()`, past every guard the entry check can offer.
    const stopped = worker.stop('deploy');
    claiming.open();
    running.open();
    await Promise.all([round, stopped]);

    // Before the fix this was ['close', 'job:start', 'job:end'] — the queue connection went away
    // under a job that had not been claimed yet when the drain took its snapshot.
    expect(trace).toEqual(['job:start', 'job:end', 'close']);
    expect((await worker.stats()).state).toBe('stopped');
    expect((await worker.stats()).processed).toBe(1);
  });

  test('the round stops claiming mid-flight — later queues are not asked', async () => {
    const asked: string[] = [];
    const entered = gate();
    const claiming = gate();
    const base = createMemoryDriver();
    const driver: JobDriver = {
      ...base,
      async claim(options: ClaimOptions): Promise<readonly ClaimedJob[]> {
        asked.push(...options.queues);
        if (asked.length === 1) {
          entered.open();
          await claiming.passed;
        }
        return [];
      },
    };

    const worker = createWorker({
      driver,
      queues: ['alpha', 'beta'],
      context,
      drainOnShutdown: false,
    });
    const round = worker.tick();
    await entered.passed;

    const stopped = worker.stop('deploy');
    claiming.open();
    await Promise.all([round, stopped]);

    // "Stop claiming" means this round too: the state is re-read per queue, not once on entry.
    expect(asked).toEqual(['alpha']);
  });

  test('a round that starts inside a drain claims nothing at all', async () => {
    const held = gate();
    let claims = 0;
    const base = createMemoryDriver();
    const driver: JobDriver = {
      ...base,
      async claim(): Promise<readonly ClaimedJob[]> {
        claims += 1;
        return [];
      },
      async close(): Promise<void> {
        await held.passed;
        await base.close();
      },
    };

    const worker = createWorker({ driver, context, drainOnShutdown: false });
    const stopped = worker.stop('deploy');
    expect(await worker.tick()).toEqual([]);

    held.open();
    await stopped;
    expect(claims).toBe(0);
  });

  test('two concurrent stops share one teardown', async () => {
    let closes = 0;
    const base = createMemoryDriver();
    const driver: JobDriver = {
      ...base,
      async close(): Promise<void> {
        closes += 1;
        await base.close();
      },
    };

    const worker = createWorker({ driver, context, drainOnShutdown: false });
    worker.start();
    await Promise.all([worker.stop('deploy'), worker.stop('SIGTERM')]);

    expect(closes).toBe(1);
  });
});

describe('a close that throws stops the worker rather than pinning it', () => {
  const failing = (): JobDriver => {
    const base = createMemoryDriver();
    return {
      ...base,
      close(): Promise<void> {
        return Promise.reject(new Error('connection reset'));
      },
    };
  };

  test('the state settles at stopped, and the failure still reaches the caller', async () => {
    const worker = createWorker({ driver: failing(), context, drainOnShutdown: false });

    worker.start();
    await expect(worker.stop('deploy')).rejects.toThrow('connection reset');

    // Set after the close, this stayed 'draining' for the life of the process: `stats()` reported
    // a drain that had already finished.
    expect((await worker.stats()).state).toBe('stopped');
  });

  test('the worker starts again — a failed close does not brick it', async () => {
    const worker = createWorker({ driver: failing(), context, drainOnShutdown: false });

    worker.start();
    await worker.stop('deploy').catch(() => undefined);
    worker.start();

    // `start()` only leaves 'idle' or 'stopped', so a worker pinned at 'draining' never ran again.
    expect((await worker.stats()).state).toBe('running');
    await worker.stop('deploy').catch(() => undefined);
    expect((await worker.stats()).state).toBe('stopped');
  });
});
