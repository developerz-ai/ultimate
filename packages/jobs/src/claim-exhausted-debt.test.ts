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

  // The auditor's repro (M1). The claim stamps every buried row's debt at T0, the burier tells them
  // one after another, and the leader counts a debt lost at T0 + grace: a row the burier reached
  // past that point was re-driven WHILE it was being told. The burier now leaves such a row owed.
  test('a burier never tells a row the leader may already be re-driving', async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const driver = memoryJobDriver({ clock });
    const tellings: { readonly id: string; readonly redriven: boolean }[] = [];
    let inHook = 0;
    let takenMidTelling = 0;
    job<OrgInput>({
      name: 'notifyOrg',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => `notify:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
      onSettled: async (settled) => {
        tellings.push({ id: settled.jobId, redriven: settled.redriven === true });
        inHook += 1;
        // Each hook runs to one millisecond short of its ceiling.
        clock.advance(ON_SETTLED_TIMEOUT_MS - 1);
        // The leader's pass, landing while the burier is still inside a telling — from the
        // third on, so the auditor's fourth (two ceilings and more past T0) is among them.
        if (settled.redriven !== true && inHook >= 3) {
          takenMidTelling += await redriveLostSettles({ driver, context, clock });
        }
      },
    });
    for (let index = 0; index < 6; index += 1) {
      await driver.enqueue({
        name: 'notifyOrg',
        queue: 'default',
        input: { orgId: `org-${index}` },
        idempotencyKey: `notify:org-${index}`,
        maxAttempts: 1,
      });
    }
    const base = { queues: ['default'], limit: 6, workerId: 'w1' };
    expect(await driver.claim({ ...base, visibilityTimeoutMs: 0 })).toHaveLength(6);
    const exhausted: JobRecord[] = [];
    await driver.claim({
      ...base,
      visibilityTimeoutMs: 30_000,
      ...burialPolicy(),
      onExhausted: (rows) => exhausted.push(...rows),
    });
    expect(exhausted).toHaveLength(6);

    await announceExhausted({ exhausted, workerId: 'w1', context, driver, clock });
    // Nothing was lost while the burier still held it: the leader took none mid-telling.
    expect(takenMidTelling).toBe(0);
    // The burier told the rows it could finish inside the grace and left the rest owed.
    expect(tellings.filter((each) => !each.redriven)).toHaveLength(3);

    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context, clock })).toBe(3);
    // Every row told exactly once, in all.
    expect(new Set(tellings.map((each) => each.id)).size).toBe(6);
    expect(tellings).toHaveLength(6);
  });

  test('a buried row of a job with no hook is never reported as left owed', async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const warned = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const driver = memoryJobDriver({ clock });
    job<OrgInput>({
      name: 'notifyOrg',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => `notify:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
      // Slow enough that the grace is spent before the hookless rows are reached.
      onSettled: () => {
        clock.advance(ON_SETTLED_TIMEOUT_MS - 1);
        return Promise.resolve();
      },
    });
    job<OrgInput>({
      name: 'plainOrg',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => `plain:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    for (const [name, index] of [
      ['notifyOrg', 0],
      ['notifyOrg', 1],
      ['notifyOrg', 2],
      ['plainOrg', 3],
    ] as const) {
      await driver.enqueue({
        name,
        queue: 'default',
        input: { orgId: `org-${index}` },
        idempotencyKey: `${name}:org-${index}`,
        maxAttempts: 1,
      });
    }
    const base = { queues: ['default'], limit: 4, workerId: 'w1' };
    expect(await driver.claim({ ...base, visibilityTimeoutMs: 0 })).toHaveLength(4);
    const exhausted: JobRecord[] = [];
    await driver.claim({
      ...base,
      visibilityTimeoutMs: 30_000,
      ...burialPolicy(),
      onExhausted: (rows) => exhausted.push(...rows),
    });
    await announceExhausted({ exhausted, workerId: 'w1', context, driver, clock });

    const leftOwed = warned.mock.calls.filter(
      ([event]) => event === 'jobs.claim.exhausted-left-owed',
    );
    expect(leftOwed.map(([, fields]) => (fields as { job: string }).job)).not.toContain('plainOrg');
  });

  // The claim pass used to tell its burials BEFORE starting the rows the same claim handed it, so
  // those rows sat leased, with no heartbeat, for as long as the tellings took.
  test("a pass starts the rows it claimed before it tells that claim's burials", async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const clock = fakeClock();
    const driver = memoryJobDriver({ clock });
    let ran = 0;
    const ranBeforeTelling: number[] = [];
    job<OrgInput>({
      name: 'notifyOrg',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => `notify:${orgId}`,
      retry: { attempts: 1 },
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
      onSettled: (settled) => {
        if (settled.outcome === 'dead-lettered') ranBeforeTelling.push(ran);
        return Promise.resolve();
      },
    });
    const enqueue = (orgId: string) =>
      driver.enqueue({
        name: 'notifyOrg',
        queue: 'default',
        input: { orgId },
        idempotencyKey: `notify:${orgId}`,
        maxAttempts: 1,
      });
    await enqueue('org-dead');
    const gone = { queues: ['default'], limit: 1, workerId: 'gone', visibilityTimeoutMs: 0 };
    expect(await driver.claim(gone)).toHaveLength(1);
    await enqueue('org-live');
    const worker = jobWorker({ driver, clock, context, drainOnShutdown: false });
    expect(await worker.tick()).toHaveLength(1);
    expect(ranBeforeTelling).toEqual([1]);
  });
});
