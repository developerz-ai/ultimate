// The worker's SIGTERM registration: exactly one hook while it runs, none once it has stopped.
// A hook per `start()` retains the driver of a worker that is already gone, and the next
// process-wide drain runs every one of them against a queue connection that is already closed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, drain, resetLifecycle, shutdownHookCount } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { createWorker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

interface ClosingDriver {
  readonly driver: JobDriver;
  closes(): number;
}

/** The memory driver with `claim` neutered (no registry needed) and `close` observable. */
function closingDriver(close?: () => Promise<void>): ClosingDriver {
  let closes = 0;
  const base = createMemoryDriver();
  return {
    driver: {
      ...base,
      async claim(): Promise<readonly ClaimedJob[]> {
        return [];
      },
      async close(): Promise<void> {
        closes += 1;
        await (close?.() ?? base.close());
      },
    },
    closes: () => closes,
  };
}

// Lifecycle registrations are process-global, so a leak here is another suite's problem too.
beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

describe('the worker holds one shutdown hook, and only while it runs', () => {
  test('start registers one, stop hands it back', async () => {
    const worker = createWorker({ driver: closingDriver().driver, context });

    worker.start();
    expect(shutdownHookCount()).toBe(1);

    await worker.stop();
    // Before the fix `onShutdown`'s unregister was discarded, so this stayed 1 for the life of
    // the process — a stopped worker still on the drain list.
    expect(shutdownHookCount()).toBe(0);
  });

  test('a restarted worker still holds one, not one per start', async () => {
    const worker = createWorker({ driver: closingDriver().driver, context });

    worker.start();
    await worker.stop();
    worker.start();
    // The `start()` guard reads 'running', so a stopped worker starts again — and registered a
    // second hook on top of the first, each retaining its own copy of this closure.
    expect(shutdownHookCount()).toBe(1);

    await worker.stop();
    expect(shutdownHookCount()).toBe(0);
  });

  test('drainOnShutdown: false registers nothing to leak', async () => {
    const worker = createWorker({
      driver: closingDriver().driver,
      context,
      drainOnShutdown: false,
    });

    worker.start();
    expect(shutdownHookCount()).toBe(0);

    await worker.stop();
    expect(shutdownHookCount()).toBe(0);
  });

  test('a close that throws still hands the hook back', async () => {
    const worker = createWorker({
      driver: closingDriver(() => Promise.reject(new Error('connection reset'))).driver,
      context,
    });

    worker.start();
    // The failure is the caller's to see — the registration is not part of the diagnosis.
    await expect(worker.stop()).rejects.toThrow('connection reset');
    expect(shutdownHookCount()).toBe(0);
  });

  test('the hook drains the worker, then is gone', async () => {
    const closing = closingDriver();
    const worker = createWorker({ driver: closing.driver, context });

    worker.start();
    await drain('SIGTERM');

    expect((await worker.stats()).state).toBe('stopped');
    expect(closing.closes()).toBe(1);
    expect(shutdownHookCount()).toBe(0);
  });

  test('a SIGTERM landing on a manual stop joins it rather than closing twice', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = closingDriver(() => held);
    const worker = createWorker({ driver: closing.driver, context });

    worker.start();
    const manual = worker.stop('deploy');
    // The hook is still registered — the worker has not finished draining, and core is entitled
    // to wait for it. What it must not do is start a second teardown of the same driver.
    const signalled = drain('SIGTERM');
    release();
    await Promise.all([manual, signalled]);

    expect(closing.closes()).toBe(1);
    expect(shutdownHookCount()).toBe(0);
  });

  test('a start during a drain neither restarts the loop nor stacks a hook', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = closingDriver(() => held);
    const worker = createWorker({ driver: closing.driver, context });

    worker.start();
    const stopped = worker.stop('deploy');
    worker.start();

    expect((await worker.stats()).state).toBe('draining');
    expect(shutdownHookCount()).toBe(1);

    release();
    await stopped;
    expect((await worker.stats()).state).toBe('stopped');
    expect(shutdownHookCount()).toBe(0);
  });
});
