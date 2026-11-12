// What every `JobDriver` records for `onSettled` (J11): a settle that ENDS a run of a job with a
// hook owes it, the hook's return clears the debt under that claim, and a debt a crash left is
// taken once per grace. A driver with no `settleDebt` runs the hook at most once, and fails here.
// Type-only imports: the barrel never loads `@ultimat3/jobs`.

import { expect } from 'bun:test';
import type { JobDriver, SettleDebt } from '@ultimat3/jobs';
import type { JobDriverCheck } from './job-driver-checks';

let minted = 0;

/** A queue and a job name of this check's own, so checks sharing one store never see each other. */
const scope = (): { readonly queue: string; readonly name: string } => {
  minted += 1;
  const tag = `${process.pid.toString(36)}-s${minted.toString(36)}`;
  return { queue: `conformance-${tag}`, name: `conformance.job-${tag}` };
};

/** One fresh row of `name` on `queue`, claimed by `workerId`. */
async function claimedRow(
  driver: JobDriver,
  at: { readonly queue: string; readonly name: string },
  key: string,
): Promise<{ readonly id: string; readonly by: { workerId: string; claim: number } }> {
  await driver.enqueue({
    name: at.name,
    queue: at.queue,
    input: {},
    idempotencyKey: key,
    maxAttempts: 3,
  });
  const [row] = await driver.claim({
    queues: [at.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w-settle',
  });
  if (row === undefined) return expect.unreachable('the row is claimable');
  return { id: row.id, by: { workerId: 'w-settle', claim: row.claim } };
}

const debtOf = (driver: JobDriver): SettleDebt => {
  if (driver.settleDebt === undefined) {
    return expect.unreachable('the driver has no settleDebt: onSettled would run at most once');
  }
  return driver.settleDebt;
};

/** The ids `takeLost` hands out for `name`, with a grace of `graceMs`. */
const lost = async (debt: SettleDebt, name: string, graceMs = 0): Promise<readonly string[]> =>
  (await debt.takeLost([{ name, graceMs }], 50)).map((row) => row.id);

export const SETTLE_DEBT_CHECKS: readonly JobDriverCheck[] = [
  {
    name: 'an ending settle of a hooked job owes onSettled until cleared under its claim',
    async run(driver) {
      const debt = debtOf(driver);
      const at = scope();
      const acked = await claimedRow(driver, at, 'acked');
      expect(await driver.ack(acked.id, { ...acked.by, owesSettle: true })).toBe(true);
      const dead = await claimedRow(driver, at, 'dead');
      expect(
        await driver.nack(dead.id, { ...dead.by, delayMs: 0, deadLetter: true, owesSettle: true }),
      ).toBe(true);
      // Owed, and TAKEN: inside the grace a second pass hands neither out again.
      expect([...(await lost(debt, at.name))].sort()).toEqual([acked.id, dead.id].sort());
      expect(await lost(debt, at.name, 60_000)).toEqual([]);
      // Never for a name this deploy has no hook for.
      expect(await lost(debt, `${at.name}-other`)).toEqual([]);
      // A clear under another claim pays nothing; under its own, the debt is gone for good.
      expect(await debt.clear(acked.id, acked.by.claim + 1)).toBe(false);
      expect(await debt.clear(acked.id, acked.by.claim)).toBe(true);
      expect(await debt.clear(acked.id, acked.by.claim)).toBe(false);
      expect(await lost(debt, at.name)).toEqual([dead.id]);
      const [row] = await debt.takeLost([{ name: at.name, graceMs: 0 }], 50);
      expect(row?.state).toBe('dead');
      expect(row?.claim).toBe(dead.by.claim);
    },
  },
  {
    name: 'a retry, a suspension and an un-hooked settle owe nothing',
    async run(driver) {
      const debt = debtOf(driver);
      const at = scope();
      const retried = await claimedRow(driver, at, 'retried');
      expect(await driver.nack(retried.id, { ...retried.by, delayMs: 0, owesSettle: true })).toBe(
        true,
      );
      const parked = await claimedRow(driver, at, 'parked');
      await driver.nack(parked.id, { ...parked.by, delayMs: 0, park: true, owesSettle: true });
      const plain = await claimedRow(driver, at, 'plain');
      expect(await driver.ack(plain.id, plain.by)).toBe(true);
      expect(await lost(debt, at.name)).toEqual([]);
    },
  },
];
