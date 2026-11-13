// The outbox-atomicity guarantee, followed all the way to a real worker. `outbox.test.ts` proves
// atomicity stops at the queue row; this proves it stops nowhere short of the handler actually
// running — a rolled-back stage must never reach a worker, a committed one must reach it exactly
// once, and a relay that republishes after a crash must not turn into a second execution. Fake
// time (`fake-time-fixture.ts`) moves every poll loop here, so each poll counted is one armed.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, ctxOf } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { memoryJobDriver } from './driver-memory';
import { useFakeTime } from './fake-time-fixture';
import { job, resetJobs } from './job';
import type { OutboxStore } from './outbox';
import { enqueueInTx, memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';
import { jobWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });
const fakeTx = (id: string): Tx => ({ id }) as unknown as Tx;

const time = useFakeTime();

/** Moves fake time until `check` holds; red after two seconds of it, never a hang. */
const waitFor = (check: () => Promise<boolean> | boolean): Promise<void> =>
  time.until(check, 2_000);

afterEach(() => {
  resetJobs();
});

describe('a rolled-back stage never reaches a worker', () => {
  test('the row vanishes with the transaction, and a real worker sees nothing to claim', async () => {
    const runs: unknown[] = [];
    const driver = memoryJobDriver();
    const store: OutboxStore = memoryOutboxStore();
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmail',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: 'none' },
      run: ({ input }) => {
        runs.push(input);
        return Promise.resolve();
      },
    });

    const tx = fakeTx('rolled-back');
    await enqueueInTx({ store, driver }, tx, handle, { orgId: 'org-1' });
    await store.rollback(tx);
    // The relay pass the committed case below takes: a row the rollback left would publish here.
    expect(await outboxRelay({ store, driver }).tick()).toBe(0);

    const worker = jobWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    try {
      // Nothing to wait FOR here — the point is the absence, so this holds the loop open across
      // twenty polls' worth of fake time instead of returning on the first empty round.
      await time.advance(100);
    } finally {
      await time.settles(worker.stop('test-end'), 100);
    }

    expect(runs).toEqual([]);
    expect((await driver.introspect?.list()) ?? []).toEqual([]);
  });
});

describe('a committed stage reaches a real worker exactly once', () => {
  test('stage, commit, relay, run — the handler fires once', async () => {
    const runs: unknown[] = [];
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const relay = outboxRelay({ store, driver });
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmailCommitted',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: 'none' },
      run: ({ input }) => {
        runs.push(input);
        return Promise.resolve();
      },
    });

    const tx = fakeTx('committed');
    await enqueueInTx({ store, driver }, tx, handle, { orgId: 'org-2' });
    await store.commit(tx);
    expect(await relay.tick()).toBe(1);

    const worker = jobWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    try {
      await waitFor(async () => {
        const [record] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return record !== undefined;
      });
    } finally {
      await time.settles(worker.stop('test-end'), 100);
    }

    expect(runs).toEqual([{ orgId: 'org-2' }]);
  });

  test('a relay that republishes after a crash still yields one execution', async () => {
    const runs: unknown[] = [];
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const handle = job<{ orgId: string }>({
      tenant: 'none',
      name: 'welcomeEmailCrashRelay',
      input: passthrough<{ orgId: string }>(),
      idempotencyKey: ({ orgId }) => `welcome:${orgId}`,
      retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: 'none' },
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

    const worker = jobWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
    worker.start();
    let rowCount = 0;
    try {
      await waitFor(async () => {
        const [done] = (await driver.introspect?.list({ state: 'done' })) ?? [];
        return done !== undefined;
      });
      // Captured before stop(): the memory driver's close() clears its jobs map.
      rowCount = ((await driver.introspect?.list()) ?? []).length;
    } finally {
      await time.settles(worker.stop('test-end'), 100);
    }

    expect(runs).toEqual([{ orgId: 'org-3' }]);
    expect(rowCount).toBe(1);
  });
});
