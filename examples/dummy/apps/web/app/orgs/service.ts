/**
 * Org and membership logic, registered as `ctx.orgs`. All the money arithmetic is delegated to
 * `@postly/core` so the same numbers come out in the web app, the admin dashboard, and an MCP
 * tool call.
 */

import { assertSeatsAvailable, quoteUpgrade } from '@postly/core';
import type { AppLocale, AppTheme, AppZone } from '@postly/domain';
import { type MemberId, type OrgId, type PlanCode, seatLimit } from '@postly/domain';
import { type Ctx, defineService } from '@ultimat3/core';
import { daysBetween, endOfBillingPeriod } from '@ultimat3/time';
import type { InviteInput, MemberView, OrgView, UpgradeReceipt } from './entity';
import { OrgNotFound } from './errors';
import {
  allDigestRecipients,
  digestRecipients,
  insertMember,
  memberById,
  memberCount,
  orgById,
  setPlan,
  updatePreferences,
} from './repo';

export const orgsService = defineService('orgs', (ctx: Ctx) => ({
  async byId(orgId: OrgId): Promise<OrgView> {
    const org = await orgById(orgId);
    if (!org) throw new OrgNotFound(orgId);
    return { ...org, seats: seatLimit(org.planCode), seatsUsed: await memberCount(orgId) };
  },

  /** Seats are checked before the row is written: a plan limit is a promise, not a warning. */
  async invite(input: InviteInput): Promise<MemberView> {
    const org = await this.byId(ctx.actor.orgId);
    assertSeatsAvailable(org.planCode, org.seatsUsed);

    const inviter = await memberById(ctx.actor.orgId, ctx.actor.memberId);
    return insertMember({
      orgId: org.id as OrgId,
      userId: await ctx.auth.ensureUser(input.email),
      email: input.email,
      name: input.email.split('@')[0] ?? input.email,
      role: input.role,
      tz: input.tz ?? (inviter?.tz as AppZone) ?? 'UTC',
      locale: input.locale ?? (inviter?.locale as AppLocale) ?? 'en',
    });
  },

  /**
   * Prorated in integer minor units, in the org's own currency. Nothing is formatted here — the
   * receipt travels as `{ minor, currency }` and `<Money>` renders it once, at the edge.
   */
  async upgrade(plan: PlanCode): Promise<UpgradeReceipt> {
    const org = await this.byId(ctx.actor.orgId);
    const periodEnd = endOfBillingPeriod(ctx.now());

    const quote = quoteUpgrade({
      from: org.planCode,
      to: plan,
      currency: org.billingCurrency,
      daysRemaining: daysBetween(ctx.now(), periodEnd),
      daysInCycle: daysBetween(endOfBillingPeriod(ctx.now(), -1), periodEnd),
    });

    await ctx.billing.charge(quote.charge, { orgId: org.id, reason: `upgrade:${plan}` });
    const updated = await setPlan(ctx.actor.orgId, plan);

    return {
      org: { ...updated, seats: seatLimit(plan), seatsUsed: org.seatsUsed },
      charge: quote.charge,
      credit: quote.credit,
      nextPeriod: quote.nextPeriod,
    };
  },

  async savePreferences(values: {
    tz?: AppZone;
    locale?: AppLocale;
    theme?: AppTheme;
    digestOptIn?: boolean;
  }): Promise<MemberView> {
    return updatePreferences(ctx.actor.orgId, ctx.actor.memberId as MemberId, values);
  },

  async memberById(memberId: MemberId): Promise<MemberView> {
    const member = await memberById(ctx.actor.orgId, memberId);
    if (!member) throw new OrgNotFound(ctx.actor.orgId);
    return member;
  },

  /** Provisioning is a step in `onboardOrg`, so it must be safe to call twice. */
  async provision(orgId: OrgId): Promise<OrgView> {
    const org = await this.byId(orgId);
    await ctx.storage.ensureBucket(`org-${org.slug}`);
    return org;
  },

  digestRecipients,

  /** Cross-tenant on purpose, and only reachable from the scheduler's job. */
  allDigestRecipients,
}));
