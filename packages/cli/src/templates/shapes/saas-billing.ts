// `--shape saas`'s billing, as app code: the plans an org can be on (a price in Money and a daily
// allowance), each plan's features as permanent flags, the one subscription row per org, and the
// two reads the app asks — which plan, and is this feature in it. No provider, no package: wraps.

import type { GeneratedFile, NameSet } from '../naming';
import { entitlementsTest, entityTest, plansTest, repoTest } from './saas-billing-tests';

export const BILLING_DIR = 'apps/web/app/billing';

const plans =
  (): string => `// The plans this app sells: a price and what each one includes. Example values — the app's to
// change. A price is Money (integer minor units and a currency), never a float. A plan's FEATURE is
// a permanent flag whose allow list is the plans that include it, so moving a feature between
// plans is one edit to its \`subjects\`, read by every check at once.

import { defineFlag } from '@ultimat3/flags';
import type { Money } from '@ultimat3/money';

export const PLAN_IDS = ['free', 'pro'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  readonly price: Money;
  /** Posts an org may create per UTC day: \`postMeter\` (\`entitlements.ts\`) draws on it. */
  readonly postsPerDay: number;
}

export const PLANS: { readonly [P in PlanId]: Plan } = {
  free: { price: { minor: 0, currency: 'USD' }, postsPerDay: 100 },
  pro: { price: { minor: 2900, currency: 'USD' }, postsPerDay: 10_000 },
};

/** An org no payment event has named yet is on this plan. */
export const DEFAULT_PLAN: PlanId = 'free';

/** A feature only a paying org has. Its \`subjects.plan\` IS the list of plans that include it. */
export const postExport = defineFlag({
  kind: 'permanent',
  key: 'plan.post-export',
  description: 'export every post of the org — a pro plan feature',
  targeting: { default: false, subjects: { plan: ['pro'] } },
});
`;

const entity =
  (): string => `// The subscription: which plan an org is on, and the payment event that put it there. One row per
// org — \`orgId\` is unique, which is also what a webhook's upsert lands on.

import { entity, enumerated, text, timestamp, uuid } from '@ultimat3/entity';
import { PLAN_IDS } from './plans';

export const subscription = entity('subscriptions', {
  // Tenant-scoped like every app table: a read runs under the actor's org, and a write naming
  // another org is refused (X_TENANCY_ACTOR_MISMATCH).
  tenant: 'orgId',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().unique(),
    plan: enumerated(PLAN_IDS),
    /** The provider's event id that last wrote this row: what a support question starts from. */
    lastEventId: text({ max: 256 }),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

export type Subscription = typeof subscription.$row;
`;

const repo = (
  app: NameSet,
): string => `// The only module that touches the subscriptions table, through the typed handle: it scopes every
// read to the actor's org, so no function here takes one to read by.

import { db } from '@${app.kebab}/db';
import type { Insertable } from '@ultimat3/entity';
import type { Subscription, subscription } from './entity';

/** The actor's org's subscription; none until a payment event names the org. */
export async function current(): Promise<Subscription | undefined> {
  return (await db.subscriptions.limit(1).one()) ?? undefined;
}

/**
 * The org's plan, as a verified payment event states it — insert or overwrite, one statement. A
 * redelivered event writes the same row again, so at-least-once delivery needs no seen-set here.
 */
export async function applyPlan(row: Insertable<typeof subscription.$columns>): Promise<void> {
  await db.subscriptions.upsertAll([row], { onConflict: ['orgId'] });
}
`;

const entitlements =
  (): string => `// What an org may do, read off its plan: the plan itself, a feature check over the plan's flags,
// and the meter that holds an org to its plan's daily allowance. Every answer is the actor's org's.

import type { ActionMeter } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { type Flag, isEnabled } from '@ultimat3/flags';
import { DEFAULT_PLAN, PLANS, type PlanId } from './plans';
import * as repo from './repo';

/** The actor's org's plan: the last payment event's, or the default before any. */
export async function planOf(): Promise<PlanId> {
  return (await repo.current())?.plan ?? DEFAULT_PLAN;
}

/**
 * Whether the actor's org's plan includes \`feature\`. Gate an action with it in \`handle\`:
 * \`if (!(await entitled(postExport, ctx.actor))) throw …\` — a policy is synchronous, a plan is a row.
 */
export async function entitled(feature: Flag, actor: Actor): Promise<boolean> {
  return isEnabled(feature.key, actor, { plan: await planOf() });
}

/**
 * Posts per org per UTC day, as many as the org's plan allows: \`createPost\` declares it, and the
 * call past the allowance is X_METER_EXCEEDED (429) on every surface.
 */
export const postMeter: ActionMeter = {
  name: 'posts',
  period: 'day',
  limit: async () => PLANS[await planOf()].postsPerDay,
};
`;

/** `apps/web/app/billing/`: plans, the subscription table and its repo, entitlements, each tested. */
export const billingFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${BILLING_DIR}/plans.ts`, contents: plans() },
  { path: `${BILLING_DIR}/plans.test.ts`, contents: plansTest() },
  { path: `${BILLING_DIR}/entity.ts`, contents: entity() },
  { path: `${BILLING_DIR}/entity.test.ts`, contents: entityTest() },
  { path: `${BILLING_DIR}/repo.ts`, contents: repo(app) },
  { path: `${BILLING_DIR}/repo.test.ts`, contents: repoTest(app) },
  { path: `${BILLING_DIR}/entitlements.ts`, contents: entitlements() },
  { path: `${BILLING_DIR}/entitlements.test.ts`, contents: entitlementsTest(app) },
];
