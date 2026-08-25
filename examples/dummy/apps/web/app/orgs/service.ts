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
  NotAMember,
  quoteUpgrade,
} from '@postly/core';
import type { AppLocale, AppTheme, AppZone } from '@postly/domain';
import { type MemberId, type OrgId, type PlanCode, seatLimit } from '@postly/domain';
// `Actor` and not `CtxFacts['actor']`: `CtxFacts` is `ServiceFactory`'s parameter type and
// @ultimat3/core does not export it, so an app cannot name the type its own factory is
// handed. Aliased because `@postly/core` already binds `Actor` to this app's membership.
import { type Actor as CtxActor, defineService } from '@ultimat3/core';
import { newId } from '@ultimat3/entity';
import type { UploadGrant, UploadRequest } from '@ultimat3/storage';
import { daysBetween, instant } from '@ultimat3/time';
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
const actingMember = (actor: CtxActor): Member => {
  const member = memberOf(actor);
  if (member === null) throw new NotAMember(actor.id);
  return member;
};

/**
 * `(ctx)` with NO annotation, which is `defineService`'s own documented form and not a shortcut.
 * The reasoning is `apps/web/app/posts/service.ts`'s, once, and not restated here: a factory's
 * parameter is `CtxFacts`, and annotating it `Ctx` made the factory that BUILDS `ctx.orgs` require
 * `ctx.orgs` to already exist.
 */
export const orgsService = defineService('orgs', (ctx) => ({
  async byId(orgId: OrgId): Promise<OrgView> {
    const org = await orgById(orgId);
    if (!org) throw new OrgNotFound(orgId);
    return { ...org, seats: seatLimit(org.planCode), seatsUsed: await memberCount(orgId) };
  },

  /** Seats are checked before the row is written: a plan limit is a promise, not a warning. */
  async invite(input: InviteInput): Promise<MemberView> {
    const member = actingMember(ctx.actor);
    const org = await this.byId(member.orgId);
    assertSeatsAvailable(org.planCode, org.seatsUsed);

    const inviter = await memberById(member.orgId, member.memberId);
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
    const member = actingMember(ctx.actor);
    const org = await this.byId(member.orgId);
    const at = instant(ctx.now());
    const periodEnd = endOfBillingPeriod(at, ctx.tz);

    const quote = quoteUpgrade({
      from: org.planCode,
      to: plan,
      currency: org.billingCurrency,
      daysRemaining: daysBetween(at, periodEnd, ctx.tz),
      daysInCycle: daysBetween(endOfBillingPeriod(at, ctx.tz, -1), periodEnd, ctx.tz),
    });

    // No charge is taken here, and there is nothing to call: `ctx.billing` was never declared in
    // `shared/services.ts` and never registered, so `ctx.billing.charge(...)` compiled only
    // because `CtxServices` carries a string index signature — and was a `TypeError` on the first
    // upgrade this app ever ran. Deleted rather than declared, exactly as `ctx.storage` and
    // `ctx.session` were: a declaration nothing installs is worse, because then it typechecks.
    // The receipt below is the QUOTE plus the plan move, which is every part of an upgrade an app
    // with no payment provider owns. Taking the money is the integration Postly does not have.
    const updated = await setPlan(member.orgId, plan);

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
    const acting = actingMember(ctx.actor);
    return updatePreferences(acting.orgId, acting.memberId, values);
  },

  async memberById(id: MemberId): Promise<MemberView> {
    const orgId = actingMember(ctx.actor).orgId;
    const member = await memberById(orgId, id);
    if (!member) throw new OrgNotFound(orgId);
    return member;
  },

  /**
   * The acting member's own row, read from the same `members` table the digest schedules off.
   * `memberId` is the actor's, so there is no argument a caller could pass to widen it — the same
   * reason `grantAvatarUpload` takes none.
   */
  async me(): Promise<MemberView> {
    const acting = actingMember(ctx.actor);
    const member = await memberById(acting.orgId, acting.memberId);
    if (!member) throw new OrgNotFound(acting.orgId);
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
