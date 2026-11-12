// The leader's re-drive of lost `onSettled` debts (J11), through `jobScheduler`: it runs on the
// leader's tick, beside the round and never inside it, at most once a minute after a pass that
// found something and every five minutes after an empty one. Fake clock, memory driver.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { SettleDebt } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import {
  jobScheduler,
  SETTLE_REDRIVE_IDLE_INTERVAL_MS,
  SETTLE_REDRIVE_INTERVAL_MS,
} from './scheduler';
import { SETTLE_GRACE_FACTOR } from './settle-redrive';
import type { JobSettled } from './settled';
import { ON_SETTLED_TIMEOUT_MS } from './settled';

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
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

/** A hooked job whose hook holds until `release` is called, and records what it was told. */
function heldHook() {
  const told: JobSettled<Record<string, never>>[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  job<Record<string, never>>({
    name: 'receipt',
    tenant: 'none',
    input: passthrough,
    idempotencyKey: () => 'receipt',
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
    onSettled: async (settled) => {
      told.push(settled);
      await held;
    },
  });
  return { told, release: () => release() };
}

afterEach(() => {
  resetJobs();
  mock.restore();
});

describe('the scheduler leader re-drives lost onSettled debts', () => {
  test('a debt past its grace is re-driven on the tick, which does not wait for the hook', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    spyOn(logger, 'info').mockImplementation(() => undefined);
    const clock = fakeClock();
    const hook = heldHook();
    const driver = memoryJobDriver({ clock });
    await driver.enqueue({
      name: 'receipt',
      queue: 'default',
      input: {},
      idempotencyKey: 'r',
      maxAttempts: 1,
    });
    const [row] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w-dead',
    });
    if (row === undefined) return expect.unreachable('the row is claimable');
    await driver.ack(row.id, { workerId: 'w-dead', claim: row.claim, owesSettle: true });
    clock.advance(ON_SETTLED_TIMEOUT_MS * SETTLE_GRACE_FACTOR);
    const scheduler = jobScheduler({
      driver,
      clock,
      tasks: [],
      drainOnShutdown: false,
      context: () => ctxOf({ role: 'scheduler', buildId: 'test' }),
    });
    // The hook is still holding: the tick answered all the same.
    expect(await scheduler.tick()).toEqual([]);
    expect(hook.told).toMatchObject([{ outcome: 'completed', redriven: true, jobId: row.id }]);
    hook.release();
    await scheduler.stop();
  });

  test('asked once a minute after a find, every five minutes after an empty pass', async () => {
    const clock = fakeClock();
    heldHook().release();
    const inner = memoryJobDriver({ clock });
    const asked: number[] = [];
    const debt: SettleDebt = {
      clear: () => Promise.resolve(false),
      takeLost: () => {
        asked.push(clock.now().getTime());
        return Promise.resolve([]);
      },
    };
    const driver = { ...inner, settleDebt: debt };
    const scheduler = jobScheduler({ driver, clock, tasks: [], drainOnShutdown: false });
    const start = clock.now().getTime();
    await scheduler.tick();
    clock.advance(SETTLE_REDRIVE_INTERVAL_MS);
    await scheduler.tick();
    clock.advance(SETTLE_REDRIVE_IDLE_INTERVAL_MS - SETTLE_REDRIVE_INTERVAL_MS);
    await scheduler.tick();
    await scheduler.stop();
    expect(asked).toEqual([start, start + SETTLE_REDRIVE_IDLE_INTERVAL_MS]);
  });

  test('a drain hands leadership back first, and the pass stops at its next row', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    spyOn(logger, 'info').mockImplementation(() => undefined);
    const clock = fakeClock();
    const hook = heldHook();
    const driver = memoryJobDriver({ clock });
    for (const key of ['r1', 'r2']) {
      await driver.enqueue({
        name: 'receipt',
        queue: 'default',
        input: {},
        idempotencyKey: key,
        maxAttempts: 1,
      });
    }
    const claimed = await driver.claim({
      queues: ['default'],
      limit: 2,
      visibilityTimeoutMs: 30_000,
      workerId: 'w-dead',
    });
    for (const row of claimed) {
      await driver.ack(row.id, { workerId: 'w-dead', claim: row.claim, owesSettle: true });
    }
    clock.advance(ON_SETTLED_TIMEOUT_MS * SETTLE_GRACE_FACTOR);
    let released = false;
    const scheduler = jobScheduler({
      driver,
      clock,
      tasks: [],
      drainOnShutdown: false,
      leader: {
        acquire: () => Promise.resolve(true),
        release: () => {
          released = true;
          return Promise.resolve();
        },
        renewEveryMs: 0,
      },
      context: () => ctxOf({ role: 'scheduler', buildId: 'test' }),
    });
    await scheduler.tick();
    expect(hook.told).toHaveLength(1);
    const stopping = scheduler.stop();
    // The first hook still holds; the lock is back with the fleet regardless.
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
    hook.release();
    await stopping;
    // The second debt was never started by a scheduler that had stopped leading.
    expect(hook.told).toHaveLength(1);
  });
});
