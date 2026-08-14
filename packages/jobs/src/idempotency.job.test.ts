// The idempotency-dedupe guarantee, run through a real worker. A queue delivers at least once —
// a caller retries an enqueue after a timeout, an outbox relay republishes — so two enqueues that
// carry the same idempotency key while one is still live must collapse into one row, and a real
// worker (`start()`/`stop()`, not `tick()`) must run the handler exactly once for it.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
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

describe('two enqueues racing on one idempotency key', () => {
  test('collapse to one row, and a real worker runs the handler exactly once', async () => {
    const runs: number[] = [];
    const driver = createMemoryDriver();
    const handle = job<{ orgId: string }>({
      name: 'provisionOrg',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `provision:${orgId}`,
      retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: false },
      run: ({ input }) => {
        runs.push(runs.length + 1);
        return Promise.resolve(input.orgId);
      },
    });

    const request = {
      name: 'provisionOrg',
      queue: 'default',
      input: { orgId: 'org-1' },
      idempotencyKey: handle.idempotencyKeyFor({ orgId: 'org-1' }),
      maxAttempts: handle.retry.attempts,
    } as const;

    // The realistic race: a caller times out waiting for the first enqueue and retries it before
    // either has landed, both hitting the driver concurrently.
    const [first, second] = await Promise.all([driver.enqueue(request), driver.enqueue(request)]);

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);

    const worker = createWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    try {
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      }, 'job reaches done');
    } finally {
      await worker.stop('test-end');
    }

    expect(runs).toEqual([1]);
  });

  test('three workers contending for the same duplicated row still run it once', async () => {
    const runs: string[] = [];
    const driver = createMemoryDriver();
    const handle = job<{ orgId: string }>({
      name: 'provisionOrgContended',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `provision:${orgId}`,
      retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: false },
      run: async ({ input, jobId }) => {
        // A slow-ish body widens the window in which a second worker COULD claim the same row
        // if dedupe or the driver's own claim exclusivity ever slipped.
        await Bun.sleep(15);
        runs.push(`${jobId}:${input.orgId}`);
      },
    });

    const request = {
      name: 'provisionOrgContended',
      queue: 'default',
      input: { orgId: 'org-2' },
      idempotencyKey: handle.idempotencyKeyFor({ orgId: 'org-2' }),
      maxAttempts: handle.retry.attempts,
    } as const;
    await Promise.all([driver.enqueue(request), driver.enqueue(request), driver.enqueue(request)]);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);

    const workers = Array.from({ length: 3 }, () =>
      createWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 }),
    );
    for (const worker of workers) worker.start();
    try {
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      }, 'job reaches done');
    } finally {
      await Promise.all(workers.map((worker) => worker.stop('test-end')));
    }

    expect(runs.length).toBe(1);
  });
});

describe('the dedupe window is "currently live", not "ever existed"', () => {
  test('a duplicate key enqueued after completion is a new, distinct run', async () => {
    const runs: string[] = [];
    const driver = createMemoryDriver();
    const handle = job<{ orgId: string }>({
      name: 'sendReceipt',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `receipt:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
      run: ({ jobId }) => {
        runs.push(jobId);
        return Promise.resolve();
      },
    });

    const enqueueOne = () =>
      driver.enqueue({
        name: 'sendReceipt',
        queue: 'default',
        input: { orgId: 'org-3' },
        idempotencyKey: handle.idempotencyKeyFor({ orgId: 'org-3' }),
        maxAttempts: handle.retry.attempts,
      });

    const worker = createWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    try {
      const firstEnqueue = await enqueueOne();
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      }, 'first run reaches done');

      const secondEnqueue = await enqueueOne();
      expect(secondEnqueue.deduped).toBe(false);
      expect(secondEnqueue.id).not.toBe(firstEnqueue.id);

      await waitFor(async () => {
        const done = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return done.length === 2;
      }, 'second run reaches done');
    } finally {
      await worker.stop('test-end');
    }

    // Two genuinely separate deliveries — receipts for two separate purchases share the key's
    // shape, not its identity, once the first one has settled.
    expect(runs.length).toBe(2);
    expect(new Set(runs).size).toBe(2);
  });
});
