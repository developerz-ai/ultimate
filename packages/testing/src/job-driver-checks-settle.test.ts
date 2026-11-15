// The settle-debt checks can fail: a driver with no `settleDebt` (an `onSettled` at most once), and
// one whose clear ignores the claim it is fenced on, and a claim that buries a hooked job's row
// owing nothing, are all caught — the memory driver passes.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver } from '@ultimat3/jobs';
import { SETTLE_DEBT_CHECKS } from './job-driver-checks-settle';

const check = (name: string) => {
  const found = SETTLE_DEBT_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no settle check named ${name}`);
  return found;
};

describe('the settle-debt checks', () => {
  test('fail a driver that records no onSettled debt', async () => {
    const { settleDebt: _debt, ...inner } = memoryJobDriver();
    const owed = check('an ending settle');
    await expect(owed.run(inner)).rejects.toThrow();
    await owed.run(memoryJobDriver());
  });

  test('fail a clear that pays a debt under any claim', async () => {
    const inner = memoryJobDriver();
    const debt = inner.settleDebt;
    if (debt === undefined) return expect.unreachable('the memory driver records the debt');
    const unfenced: JobDriver = {
      ...inner,
      // Every row the check settles is on its first claim: `1` is the claim each one carries.
      settleDebt: { ...debt, clear: (jobId) => debt.clear(jobId, 1) },
    };
    await expect(check('an ending settle').run(unfenced)).rejects.toThrow();
  });

  test('fail a claim that buries a hooked job and records no debt', async () => {
    const inner = memoryJobDriver();
    const forgetful: JobDriver = {
      ...inner,
      claim: ({ settleOwed: _owed, ...options }) => inner.claim(options),
    };
    const owed = check('a row the claim buries');
    await expect(owed.run(forgetful)).rejects.toThrow();
    await owed.run(memoryJobDriver());
  });
});
