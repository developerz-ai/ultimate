/**
 * Org and membership logic, registered as `ctx.orgs`. All the money arithmetic is delegated to
 * `@postly/core` so the same numbers come out in the web app, the admin dashboard, and an MCP
 * tool call.
 */

import {
  assertSeatsAvailable,
  endOfBillingPeriod,
  type Actor as Member,
  memberOf,
  quoteUpgrade,
} from '@postly/core';
import type { AppLocale, AppTheme, AppZone } from '@postly/domain';
import { type MemberId, type OrgId, type PlanCode, seatLimit } from '@postly/domain';
import { type Ctx, defineService } from '@ultimat3/core';
import { newId } from '@ultimat3/entity';
import type { UploadGrant, UploadRequest } from '@ultimat3/storage';
import { daysBetween, instant } from '@ultimat3/time';
import { NotAMember } from '../../shared/errors';
import { mintAvatarGrant, signedAvatarUrl } from './avatar';
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

/**
 * Who the avatar calls act for. `memberOf` is the same projection every policy predicate starts
 * from, so the service and the rule that guards it read one definition of "a member" — and an
 * actor without one is refused here rather than reaching storage with an undefined org.
 */
const actingMember = (actor: Ctx['actor']): Member => {
  const member = memberOf(actor);
  if (member === null) throw new NotAMember(actor.id);
  return member;
};

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
      // A fresh identity, linked when they first sign in — `members.userId` is Better Auth's id
      // and this app owns no user table, so there is nothing here to look one up in.
      //
      // It read `ctx.auth.ensureUser(input.email)` until 2026-08, and `ctx.auth` was NEVER a
      // service: nothing declares it in `CtxServices`, nothing registers it, and the string index
      // signature on `Ctx` made `ctx.anything` compile as `unknown` — so this line type-checked and
      // was a `TypeError` on the first invite. Exactly the defect `shared/services.ts` records for
      // `session` and `channel`; this was the third instance, and the one still live.
      //
      // Deliberately NOT a lookup by email across orgs: `repo.ts` says `allDigestRecipients` is the
      // one statement in this app that spans tenants, and a second one here would be an oracle for
      // "does this address have an account anywhere".
      userId: newId(),
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
   *
   * The period is a calendar month in `ctx.tz`, read once: three separate `ctx.now()` calls could
   * straddle local midnight and quote a cycle the org was never on.
   */
  async upgrade(plan: PlanCode): Promise<UpgradeReceipt> {
    const org = await this.byId(ctx.actor.orgId);
    const at = instant(ctx.now());
    const periodEnd = endOfBillingPeriod(at, ctx.tz);

    const quote = quoteUpgrade({
      from: org.planCode,
      to: plan,
      currency: org.billingCurrency,
      daysRemaining: daysBetween(at, periodEnd, ctx.tz),
      daysInCycle: daysBetween(endOfBillingPeriod(at, ctx.tz, -1), periodEnd, ctx.tz),
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

  /**
   * A presigned PUT for the acting member's own avatar. The org is the actor's, never the
   * request's, and the key is derived from it inside `@ultimat3/storage` — see `avatar.ts`.
   */
  async grantAvatarUpload(request: UploadRequest): Promise<UploadGrant> {
    const member = actingMember(ctx.actor);
    return mintAvatarGrant({
      orgId: member.orgId,
      memberId: member.memberId,
      request,
      // The request clock, so a grant minted inside a frozen test expires at a knowable instant.
      clock: ctx.clock,
    });
  },

  /** The acting member's current avatar as a short-lived signed URL, or `null` if they have none. */
  async avatarUrl(): Promise<string | null> {
    const member = actingMember(ctx.actor);
    return signedAvatarUrl(member.orgId, member.memberId);
  },

  digestRecipients,

  /** Cross-tenant on purpose, and only reachable from the scheduler's job. */
  allDigestRecipients,
}));
