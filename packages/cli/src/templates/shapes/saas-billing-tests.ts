// `--shape saas`'s billing tests: each billing file's unit suite, against the in-memory driver.
// Beside `saas-billing.ts`, which holds the sources they test.

import type { NameSet } from '../naming';

export const plansTest =
  (): string => `// The plans as data: every price is Money, every allowance a whole count, and a feature answers
// by the plan it is asked about — never by who is asking.
import { isEnabled } from '@ultimat3/flags';
import { testActor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { DEFAULT_PLAN, PLAN_IDS, PLANS, postExport } from './plans';

const actor = testActor('member', { orgId: '00000000-0000-4000-8000-0000000000b1' }).actor;

unitTest('every plan has an integer price with its currency, and a whole allowance', () => {
  for (const id of PLAN_IDS) {
    expect(Number.isSafeInteger(PLANS[id].price.minor)).toBe(true);
    expect(PLANS[id].price.currency).toMatch(/^[A-Z]{3}$/);
    expect(Number.isSafeInteger(PLANS[id].postsPerDay)).toBe(true);
  }
  expect(PLAN_IDS).toContain(DEFAULT_PLAN);
});

unitTest('a plan feature is on for the plans its flag names, and off for the rest', () => {
  expect(isEnabled(postExport.key, actor, { plan: 'pro' })).toBe(true);
  expect(isEnabled(postExport.key, actor, { plan: 'free' })).toBe(false);
});
`;

export const entityTest =
  (): string => `// The subscription table's declaration: tenant-scoped, and one row per org.
import { expect, unitTest } from '@ultimat3/testing';
import { subscription } from './entity';

unitTest('subscriptions is tenant-scoped by orgId', () => {
  expect(subscription.$name).toBe('subscriptions');
  expect(subscription.$tenantColumn).toBe('orgId');
  expect(subscription.$describe().orgScoped).toBe(true);
});

unitTest('a plan outside the declared ones does not parse', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-0000000000b1',
    plan: 'pro',
    lastEventId: 'evt_1',
    updatedAt: new Date(0),
  };
  expect(subscription.$parse(row).plan).toBe('pro');
  expect(() => subscription.$parse({ ...row, plan: 'platinum' })).toThrow();
});
`;

export const repoTest = (
  app: NameSet,
): string => `// The subscriptions repo against the in-memory driver: one row per org, overwritten in place, and
// never read across orgs.
import { driver } from '@${app.kebab}/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from './repo';

const orgId = '00000000-0000-4000-8000-0000000000b1';
const otherOrg = '00000000-0000-4000-8000-0000000000b9';

const inOrg = <T>(org: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: testActor('billing', { orgId: org }).actor }), run);

afterEach(() => {
  driver.reset?.();
});

unitTest('no event yet is no subscription', async () => {
  expect(await inOrg(orgId, repo.current)).toBeUndefined();
});

unitTest('a second event overwrites the one row, never adds one', async () => {
  await inOrg(orgId, () => repo.applyPlan({ orgId, plan: 'pro', lastEventId: 'evt_1' }));
  await inOrg(orgId, () => repo.applyPlan({ orgId, plan: 'free', lastEventId: 'evt_2' }));
  expect(await inOrg(orgId, repo.current)).toMatchObject({ plan: 'free', lastEventId: 'evt_2' });
});

unitTest("another org's subscription is never read", async () => {
  await inOrg(orgId, () => repo.applyPlan({ orgId, plan: 'pro', lastEventId: 'evt_1' }));
  expect(await inOrg(otherOrg, repo.current)).toBeUndefined();
});

unitTest('a write for another org than the actor is refused', async () => {
  const write = () => repo.applyPlan({ orgId: otherOrg, plan: 'pro', lastEventId: 'evt_1' });
  const refused = await inOrg(orgId, write).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');
});
`;

export const entitlementsTest = (
  app: NameSet,
): string => `// Entitlements follow the plan row: no row is the default plan, and a row the payment webhook
// writes changes the features and the allowance the next call reads.
import { driver } from '@${app.kebab}/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { entitled, planOf, postMeter } from './entitlements';
import { PLANS, postExport } from './plans';
import * as repo from './repo';

const orgId = '00000000-0000-4000-8000-0000000000b1';
const member = testActor('member', { orgId }).actor;
const ctx = ctxOf({ actor: member });
const inOrg = <T>(run: () => Promise<T>): Promise<T> => runWithContext(ctx, run);

const allowance = (): Promise<number> => {
  const { limit } = postMeter;
  return inOrg(async () => (typeof limit === 'number' ? limit : limit({ ctx })));
};

afterEach(() => {
  driver.reset?.();
});

unitTest('an org no event has named is on the default plan, without its features', async () => {
  expect(await inOrg(planOf)).toBe('free');
  expect(await inOrg(() => entitled(postExport, member))).toBe(false);
  expect(await allowance()).toBe(PLANS.free.postsPerDay);
});

unitTest("an upgrade turns the plan's features on and raises the allowance", async () => {
  await inOrg(() => repo.applyPlan({ orgId, plan: 'pro', lastEventId: 'evt_up' }));
  expect(await inOrg(planOf)).toBe('pro');
  expect(await inOrg(() => entitled(postExport, member))).toBe(true);
  expect(await allowance()).toBe(PLANS.pro.postsPerDay);
});
`;
