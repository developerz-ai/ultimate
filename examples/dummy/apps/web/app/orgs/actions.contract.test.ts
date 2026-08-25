/**
 * contract — the org commands that WRITE, and the two statements behind them that had never run.
 *
 * `upgradePlan` is the only path in Postly that moves money and the only one that moves a plan,
 * and until 2026-08-24 nothing exercised it: `ctx.orgs.upgrade()` called `ctx.billing.charge(...)`
 * against a service nothing declares and nothing registers, and `setPlan` chained
 * `.where({ id }).update({ planCode }).returning()` onto a `ReadBuilder` that has neither method.
 * Two `TypeError`s in one call, under a green suite, on the action the admin dashboard exposes and
 * `mcp: { expose: true }` hands to an agent. Both are gone; these are the tests that would have
 * caught them.
 *
 * Registration happens in `scripts/test-setup.ts`, the preload — this file does not import `api/`.
 */

import { orgId, priceOf, seatLimit } from '@postly/domain';
import { expect, test } from '@ultimat3/testing';
import { upgradePlan } from './actions';
import { orgById } from './repo';

test('upgradePlan moves the plan and answers a receipt in the org’s own currency', async ({
  seed,
  actorFor,
}) => {
  // Tinta is on `free` in EUR, and Mara owns it — `org:administer` is owner-only, so the seat
  // holder who can run this is the one the seed makes an owner.
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });

  const receipt = await upgradePlan.as(actorFor(owner), { orgId: org.id, plan: 'team' });

  expect(receipt.org.planCode).toBe('team');
  expect(receipt.org.seats).toBe(seatLimit('team'));
  // The catalog row, never a conversion: Postly prices each plan in each currency and never
  // crosses between them.
  expect(receipt.nextPeriod).toEqual(priceOf('team', 'EUR'));
  expect(receipt.charge.currency).toBe('EUR');
  // Prorated by the days left in the period, so it is never more than a full period …
  expect(receipt.charge.minor).toBeLessThanOrEqual(priceOf('team', 'EUR').minor);
  // … and never negative: `free` credits nothing back, so the charge is what is owed.
  expect(receipt.charge.minor).toBeGreaterThanOrEqual(0);
  expect(receipt.credit.minor).toBe(0);

  // The receipt is the row `setPlan` wrote, so this second read is what proves the statement
  // reached the store rather than the response being assembled from the input.
  expect((await orgById(orgId(receipt.org.id)))?.planCode).toBe('team');
});

test('upgradePlan refuses an org admin — the contract is the owner’s, not the roster’s', async ({
  seed,
  actorFor,
}) => {
  const { org, admin } = await seed('dev').pick({ org: 'org:tinta', admin: 'member:noa' });

  await expect(
    upgradePlan.as(actorFor(admin), { orgId: org.id, plan: 'team' }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');

  // And nothing moved. A denial that still wrote would be the worse half of the same bug.
  expect((await orgById(orgId(org.id)))?.planCode).toBe('free');
});
