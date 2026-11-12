// One re-drive pass holds its taken debts for one grace only: it drives serially, so a slow pass
// must stop before a debt it has not reached counts as lost again and another leader retakes it —
// and it stops when its leader does. Memory driver, fake clock: hooks spend time by assignment.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { redriveLostSettles, SETTLE_GRACE_FACTOR } from './settle-redrive';
import { ON_SETTLED_TIMEOUT_MS } from './settled';

const GRACE_MS = ON_SETTLED_TIMEOUT_MS * SETTLE_GRACE_FACTOR;

const passthrough: StandardSchemaV1<unknown, { readonly n: number }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as { readonly n: number } }),
  },
};

const fakeClock = (): Clock & { advance(ms: number): void } => {
  let current = Date.UTC(2026, 10, 12);
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const context = (): Ctx => ctxOf({ role: 'scheduler', buildId: 'test' });

/** `count` rows acked owing their hook, by a worker that died before running it. */
async function owe(driver: JobDriver, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    await driver.enqueue({
      name: 'slowHook',
      queue: 'default',
      input: { n },
      idempotencyKey: `slow:${n}`,
      maxAttempts: 1,
    });
  }
  const claimed = await driver.claim({
    queues: ['default'],
    limit: count,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  for (const row of claimed) {
    await driver.ack(row.id, { workerId: 'w1', claim: row.claim, owesSettle: true });
  }
}

afterEach(() => {
  resetJobs();
  mock.restore();
});

describe('one re-drive pass', () => {
  test('drives no debt it could not finish inside the grace its take bought', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: number[] = [];
    job<{ readonly n: number }>({
      name: 'slowHook',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ n }) => `slow:${n}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
      // Each hook spends one and a half ceilings: the third would start past (factor - 1) of them.
      onSettled: ({ input }) => {
        told.push(input?.n ?? -1);
        clock.advance(ON_SETTLED_TIMEOUT_MS * 1.5);
        return Promise.resolve();
      },
    });
    const driver = memoryJobDriver({ clock });
    await owe(driver, 3);
    clock.advance(GRACE_MS);
    await redriveLostSettles({ driver, context, clock });
    expect(told).toHaveLength(2);
    // The one left was never started, and is owed still: the next pass past the grace takes it.
    clock.advance(GRACE_MS);
    await redriveLostSettles({ driver, context, clock });
    expect(told).toHaveLength(3);
  });

  test('stops between rows once its leader has stopped leading', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: number[] = [];
    job<{ readonly n: number }>({
      name: 'slowHook',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ n }) => `slow:${n}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
      onSettled: ({ input }) => {
        told.push(input?.n ?? -1);
        return Promise.resolve();
      },
    });
    const driver = memoryJobDriver({ clock });
    await owe(driver, 3);
    clock.advance(GRACE_MS);
    await redriveLostSettles({ driver, context, clock, stopped: () => told.length >= 1 });
    expect(told).toHaveLength(1);
  });
});
