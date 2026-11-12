// `onSettled` at least once (J11): a worker killed between its settle and the hook leaves a debt
// the leader re-drives once, `redriven: true`; a hook that returned paid its debt, so no pass
// re-drives it. Memory driver, fake clock: the grace passes by assignment, never by a sleep.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver, SettleDebt } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { job, resetJobs } from './job';
import { redriveLostSettles, SETTLE_GRACE_FACTOR } from './settle-redrive';
import type { JobSettled } from './settled';
import { ON_SETTLED_TIMEOUT_MS } from './settled';

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

/** A job whose hook records what it was told; `fail` makes its body throw, `returns` its result. */
function hookedJob(
  told: JobSettled<OrgInput, string | undefined>[],
  fail = false,
  returns: string | undefined = undefined,
) {
  return job<OrgInput, string | undefined>({
    name: 'notifyOrg',
    tenant: 'none',
    input: passthrough,
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 1, deadLetter: true },
    run: () => (fail ? Promise.reject(new TypeError('provider down')) : Promise.resolve(returns)),
    onSettled: (settled) => {
      told.push(settled);
      return Promise.resolve();
    },
  });
}

/** The memory driver with its debt's `clear` refused: a worker that died before paying. */
function unpaid(driver: JobDriver): { readonly driver: JobDriver; readonly cleared: unknown[][] } {
  const debt = driver.settleDebt;
  if (debt === undefined) return expect.unreachable('the memory driver records the debt');
  const cleared: unknown[][] = [];
  const dying: SettleDebt = {
    takeLost: (jobs, limit) => debt.takeLost(jobs, limit),
    clear: (...args) => {
      cleared.push(args);
      return Promise.resolve(false);
    },
  };
  return { driver: { ...driver, settleDebt: dying }, cleared };
}

async function claimOne(driver: JobDriver) {
  await driver.enqueue({
    name: 'notifyOrg',
    queue: 'default',
    input: { orgId: 'org-7' },
    idempotencyKey: 'notify:org-7',
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  if (claimed === undefined) return expect.unreachable('the row is claimable');
  return claimed;
}

afterEach(() => {
  resetJobs();
  mock.restore();
});

describe('redriveLostSettles', () => {
  test('an ack whose worker died before the hook is re-driven once, redriven: true', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput, string | undefined>[] = [];
    hookedJob(told);
    const driver = memoryJobDriver({ clock });
    const claimed = await claimOne(driver);
    // Killed between the two: the ack recorded the debt, and the hook never ran.
    const by = { workerId: 'w1', claim: claimed.claim, owesSettle: true };
    expect(await driver.ack(claimed.id, by)).toBe(true);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(1);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      outcome: 'completed',
      redriven: true,
      reason: 'lost',
      result: undefined,
      jobId: claimed.id,
      input: { orgId: 'org-7' },
    });
    // Paid by the hook's return: a second reaper pass, past another grace, finds nothing.
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
    expect(told).toHaveLength(1);
  });

  test('executeJob records the debt on its ack and pays it once the hook returns', async () => {
    const clock = fakeClock();
    const told: JobSettled<OrgInput, string | undefined>[] = [];
    const handle = hookedJob(told);
    const { driver, cleared } = unpaid(memoryJobDriver({ clock }));
    const claimed = await claimOne(driver);
    await executeJob({ driver, claimed, handle, ctx: context(), clock });
    expect(told.map((each) => [each.outcome, each.redriven])).toEqual([['completed', undefined]]);
    expect(cleared).toEqual([[claimed.id, claimed.claim]]);
    // The clear was refused, so the debt stands and the leader re-drives it past the grace.
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(1);
    expect(told[1]).toMatchObject({ outcome: 'completed', redriven: true, reason: 'lost' });
  });

  test('a completion that returned a value owes nothing: told once, at most once', async () => {
    const clock = fakeClock();
    const told: JobSettled<OrgInput, string | undefined>[] = [];
    const handle = hookedJob(told, false, 'sent');
    const { driver, cleared } = unpaid(memoryJobDriver({ clock }));
    const claimed = await claimOne(driver);
    await executeJob({ driver, claimed, handle, ctx: context(), clock });
    expect(told).toMatchObject([{ outcome: 'completed', result: 'sent' }]);
    // No debt was recorded, so none is paid and none is re-driven: the value is never stored.
    expect(cleared).toEqual([]);
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(0);
    expect(told).toHaveLength(1);
  });

  test('a dead letter is owed too, and re-driven with its recorded failure', async () => {
    spyOn(logger, 'warn').mockImplementation(() => undefined);
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const clock = fakeClock();
    const told: JobSettled<OrgInput, string | undefined>[] = [];
    const handle = hookedJob(told, true);
    const { driver } = unpaid(memoryJobDriver({ clock }));
    const claimed = await claimOne(driver);
    await executeJob({ driver, claimed, handle, ctx: context(), clock });
    clock.advance(GRACE_MS);
    expect(await redriveLostSettles({ driver, context })).toBe(1);
    expect(told.map((each) => [each.outcome, each.redriven])).toEqual([
      ['dead-lettered', undefined],
      ['dead-lettered', true],
    ]);
    expect(told[1]).toMatchObject({ reason: 'lost', error: expect.stringContaining('provider') });
  });

  test('no hooked job, no statement: the debt is never asked', async () => {
    job<OrgInput>({
      name: 'plain',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => orgId,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    const inner = memoryJobDriver();
    let asked = 0;
    const debt: SettleDebt = {
      clear: () => Promise.resolve(false),
      takeLost: () => {
        asked += 1;
        return Promise.resolve([]);
      },
    };
    expect(await redriveLostSettles({ driver: { ...inner, settleDebt: debt }, context })).toBe(0);
    expect(asked).toBe(0);
  });
});
