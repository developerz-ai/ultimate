// A row the CLAIM settles owes `onSettled` at least once (J11): the burial records the debt in its
// own write (`burialPolicy().settleOwed`), the burier's telling pays it, and a burier that died
// before telling leaves it for the leader's re-drive. Memory driver, fake clock, no sleep.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { announceExhausted, burialPolicy } from './claim-exhausted';
import type { JobDriver, JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { redriveLostSettles, SETTLE_GRACE_FACTOR } from './settle-redrive';
import type { JobSettled } from './settled';
import { ON_SETTLED_TIMEOUT_MS } from './settled';
import { jobWorker } from './worker';

interface OrgInput {
  readonly orgId: string;
}

const passthrough: StandardSchemaV1<unknown, OrgInput> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as OrgInput }),
  },
};

const GRACE_MS = ON_SETTLED_TIMEOUT_MS * SETTLE_GRACE_FACTOR;

const fakeClock = (): Clock & { advance(ms: number): void } => {
  let current = Date.UTC(2026, 10, 14);
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

/** A hooked job that records each telling, and a plain one that drops its exhausted rows. */
function declare(told: JobSettled<OrgInput>[]): void {
  job<OrgInput>({
    name: 'notifyOrg',
    tenant: 'none',
    input: passthrough,
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
    onSettled: (settled) => {
      told.push(settled);
      return Promise.resolve();
    },
  });
  job<OrgInput>({
    name: 'quietOrg',
    tenant: 'none',
    input: passthrough,
    idempotencyKey: ({ orgId }) => `quiet:${orgId}`,
    retry: { attempts: 1, deadLetter: false },
    run: () => Promise.resolve(),
  });
}

/** A final attempt whose worker died (a 0 ms lease), then buried by the next claim's policy. */
async function bury(driver: JobDriver): Promise<readonly JobRecord[]> {
  await driver.enqueue({
    name: 'notifyOrg',
    queue: 'default',
    input: { orgId: 'org-7' },
    idempotencyKey: 'notify:org-7',
    maxAttempts: 1,
  });
  const base = { queues: ['default'], limit: 1, workerId: 'w1' };
  expect(await driver.claim({ ...base, visibilityTimeoutMs: 0 })).toHaveLength(1);
  const buried: JobRecord[] = [];
  const handed = await driver.claim({
    ...base,
    visibilityTimeoutMs: 30_000,
    ...burialPolicy(),
    onExhausted: (rows) => buried.push(...rows),
  });
  expect(handed).toEqual([]);
  return buried;
}

afterEach(() => {
  resetJobs();
  mock.restore();
});

describe('a burial owes onSettled', () => {
  test('burialPolicy names the dropped and the hooked jobs, from the registry', () => {
    declare([]);
    expect(burialPolicy()).toEqual({ dropExhausted: ['quietOrg'], settleOwed: ['notifyOrg'] });
  });

  test('a burier that dies before telling leaves the debt to the leader: redriven, lost', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput>[] = [];
    declare(told);
    const driver = memoryJobDriver({ clock });
    const [row] = await bury(driver);
    expect(row?.state).toBe('dead');
    // No `announceExhausted`: the worker was killed between the claim and the telling.
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(1);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      outcome: 'dead-lettered',
      redriven: true,
      reason: 'lost',
      error: LEASE_LAPSED_FINAL_ATTEMPT,
      jobId: row?.id,
      input: { orgId: 'org-7' },
    });
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
  });

  test("the burier's telling pays the debt: no re-drive after it", async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput>[] = [];
    declare(told);
    const driver = memoryJobDriver({ clock });
    const exhausted = await bury(driver);
    expect(await announceExhausted({ exhausted, workerId: 'w1', context, driver })).toEqual({
      deadLettered: 1,
      dropped: 0,
    });
    expect(told.map((each) => each.redriven)).toEqual([undefined]);
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
    expect(told).toHaveLength(1);
  });

  /** A worker's claim round over the final attempt a dead worker held (a 0 ms lease). */
  async function workerRound(driver: JobDriver, clock: Clock): Promise<void> {
    await driver.enqueue({
      name: 'notifyOrg',
      queue: 'default',
      input: { orgId: 'org-7' },
      idempotencyKey: 'notify:org-7',
      maxAttempts: 1,
    });
    const gone = { queues: ['default'], limit: 1, workerId: 'gone', visibilityTimeoutMs: 0 };
    expect(await driver.claim(gone)).toHaveLength(1);
    const worker = jobWorker({ driver, clock, context, drainOnShutdown: false });
    expect(await worker.tick()).toEqual([]);
  }

  test("a worker's claim round buries, tells and pays: the leader finds nothing", async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput>[] = [];
    declare(told);
    const driver = memoryJobDriver({ clock });
    await workerRound(driver, clock);
    expect(told.map((each) => [each.outcome, each.redriven])).toEqual([
      ['dead-lettered', undefined],
    ]);
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
    expect(told).toHaveLength(1);
  });

  test("a worker's claim records the debt: unpaid, the leader re-drives it", async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput>[] = [];
    declare(told);
    const inner = memoryJobDriver({ clock });
    const debt = inner.settleDebt;
    if (debt === undefined) return expect.unreachable('the memory driver records the debt');
    // Killed after the telling, before its clear landed.
    const driver: JobDriver = {
      ...inner,
      settleDebt: { ...debt, clear: () => Promise.resolve(false) },
    };
    await workerRound(driver, clock);
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver: inner, context })).toBe(1);
    expect(told.map((each) => each.redriven)).toEqual([undefined, true]);
  });
});
