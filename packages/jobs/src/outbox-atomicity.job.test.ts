// The outbox-atomicity guarantee, followed all the way to a real worker. `outbox.test.ts` proves
// atomicity stops at the queue row; this proves it stops nowhere short of the handler actually
// running — a rolled-back stage must never reach a worker, a committed one must reach it exactly
// once, and a relay that republishes after a crash must not turn into a second execution.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { OutboxStore } from './outbox';
import { createMemoryOutboxStore, createOutboxRelay, enqueueInTx } from './outbox';
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
const fakeTx = (id: string): Tx => ({ id }) as unknown as Tx;

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

describe('a rolled-back stage never reaches a worker', () => {
  test('the row vanishes with the transaction, and a real worker sees nothing to claim', async () => {
    const runs: unknown[] = [];
    const driver = createMemoryDriver();
    const store: OutboxStore = createMemoryOutboxStore();
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmail',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
      run: ({ input }) => {
        runs.push(input);
        return Promise.resolve();
      },
    });

    const tx = fakeTx('rolled-back');
    await enqueueInTx({ store, driver }, tx, handle, { orgId: 'org-1' });
    await store.rollback(tx);

    const worker = createWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    try {
      // Nothing to wait FOR here — the point is the absence, so this holds the loop open across
      // a bounded number of real polls instead of returning on the first empty round.
      for (let i = 0; i < 20; i += 1) await Bun.sleep(5);
    } finally {
      await worker.stop('test-end');
    }

    expect(runs).toEqual([]);
    expect((await driver.introspect?.list()) ?? []).toEqual([]);
  });
});

describe('a committed stage reaches a real worker exactly once', () => {
  test('stage, commit, relay, run — the handler fires once', async () => {
    const runs: unknown[] = [];
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const relay = createOutboxRelay({ store, driver });
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmailCommitted',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
      run: ({ input }) => {
        runs.push(input);
        return Promise.resolve();
      },
    });

    const tx = fakeTx('committed');
    await enqueueInTx({ store, driver }, tx, handle, { orgId: 'org-2' });
    await store.commit(tx);
    expect(await relay.tick()).toBe(1);

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

    expect(runs).toEqual([{ orgId: 'org-2' }]);
  });

  test('a relay that republishes after a crash still yields one execution', async () => {
    const runs: unknown[] = [];
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmailCrashRelay',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
      run: ({ input }) => {
        runs.push(input);
        return Promise.resolve();
      },
    });

    const tx = fakeTx('crash-relay');
    await enqueueInTx({ store, driver }, tx, handle, { orgId: 'org-3' });
    const [record] = await store.commit(tx);
    if (record === undefined) throw new Error('expected one staged record');

    // Simulate the crash the relay's own comment names: publish landed, `markPublished` did not,
    // so the next tick (or, here, a second manual publish) republishes the same row.
    const publish = () =>
      driver.enqueue({
        name: record.job,
        queue: record.queue,
        input: record.input,
        idempotencyKey: record.idempotencyKey,
        maxAttempts: record.maxAttempts,
      });
    const [first, second] = await Promise.all([publish(), publish()]);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);

    const worker = createWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    let rowCount = 0;
    try {
      await waitFor(async () => {
        const [done] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return done !== undefined;
      }, 'job reaches done');
      // Captured before stop(): the memory driver's close() clears its jobs map.
      rowCount = ((await driver.introspect?.list()) ?? []).length;
    } finally {
      await worker.stop('test-end');
    }

    expect(runs).toEqual([{ orgId: 'org-3' }]);
    expect(rowCount).toBe(1);
  });
});
