/**
 * Postly's MCP server. `include: 'exposed'` pulls in every action and query that declared
 * `mcp: { expose: true }` — with their policies, not copies of them. Only tools that are *not*
 * actions are written out here.
 *
 * No `resolveToken` yet, so `mcp.route` is `undefined` — this server is reachable in-process
 * (`mcp.server.handle(body, caller)`, what `apps/web/app/posts/mcp-drive.contract.test.ts`
 * drives) but not yet mounted at `POST /mcp`. Wiring one needs a real bearer-token → member
 * resolution, which needs Postly to issue agent tokens in the first place — neither exists yet.
 * `packages/admin/src/mcp.ts` (the framework's own admin package) is the shape to follow once
 * they do — it wraps `resolveToken` around the same `actor({ token })` hook its HTTP surface
 * already uses.
 *
 * `t` comes from @ultimat3/mcp, not @ultimat3/schema: an MCP file imports one package.
 */

import {
  billingPeriodAt,
  localDateIn,
  memberOf,
  NotAMember,
  nextDigestAt,
  previousDigestAt,
  quoteUpgrade,
  seatsRemaining,
} from '@postly/core';
import { type OrgId, orgId, PLAN_CODES, seatLimit } from '@postly/domain';
import type { Actor } from '@ultimat3/core';
import { defineAppMcp, t } from '@ultimat3/mcp';

/**
 * The org an agent's call acts in. `ctx.actor.orgId` is `string | undefined` on core's `Actor` —
 * the framework cannot know an app requires a tenant — so every read below typechecked nowhere an
 * `OrgId` was wanted. `memberOf` is the same projection every policy predicate starts from, so a
 * tool and the rule that guards it read one definition of "a member".
 */
const actingOrg = (actor: Actor): OrgId => {
  const member = memberOf(actor);
  if (member === null) throw new NotAMember(actor.id);
  return member.orgId;
};

export const mcp = defineAppMcp({
  name: 'postly',
  /** Every `mcp: { expose: true }` declaration in the app, with its policy unchanged. */
  include: 'exposed',
  /** Exposes the versioned prompt artifact so an agent can read what the model was told. */
  prompts: ['apps/web/app/posts/prompts/summarize.v4.md'],

  tools: {
    /** Read-only. Answers "what will I get tonight, and when?" without waiting until tonight. */
    digestPreview: {
      description:
        'Preview the acting member’s next digest: delivery instant in their timezone and the posts it would contain. Read-only, sends nothing.',
      input: t.object({}),
      policy: 'member:self',
      /** Read-only. `destructive` defaults to true, so a read tool must say so. */
      destructive: false,
      async handle({ ctx }) {
        // The member ROW, not the actor and not `ctx.tz`: the digest promises "09:00 where you
        // are" and `members.tz` is the column the scheduler reads, so a preview off any other
        // zone is a preview of a delivery that will not happen. `ctx.actor.tz` did not exist —
        // core's `Actor` carries id, roles, scopes and tenant, and an app's own columns are never
        // on it.
        const member = await ctx.orgs.me();
        const at = nextDigestAt(ctx.now(), member.tz);
        // The delivery's own window, to the millisecond: `previousDigestAt`, not
        // `at - 86_400_000`, or this preview disagrees with tonight's mail on the two days a
        // year the member's clock moves. A preview that is not the digest is not a preview.
        const posts = await ctx.posts.publishedSince(
          orgId(member.orgId),
          previousDigestAt(at, member.tz),
        );
        return {
          deliverAt: at.toISOString(),
          localDate: localDateIn(at, member.tz),
          zone: member.tz,
          posts: posts.map((post) => ({ id: post.id, title: post.title })),
        };
      },
    },

    /** Three reads an agent would otherwise stitch together, and get subtly wrong. */
    seatReport: {
      description:
        'Seats used, seats remaining and the plan limit for the acting organisation. Read-only.',
      input: t.object({}),
      policy: 'org:administer',
      /** Read-only. `destructive` defaults to true, so a read tool must say so. */
      destructive: false,
      async handle({ ctx }) {
        const org = await ctx.orgs.byId(actingOrg(ctx.actor));
        return {
          plan: org.planCode,
          limit: seatLimit(org.planCode),
          used: org.seatsUsed,
          remaining: seatsRemaining(org.planCode, org.seatsUsed),
        };
      },
    },

    /**
     * Deliberately separate from `upgradePlan`: an agent must be able to answer "what would this
     * cost?" without the tool that spends money being the only way to find out.
     */
    planQuote: {
      description:
        'Quote a prorated upgrade in minor units for the acting organisation. Charges nothing — use upgradePlan to actually move.',
      input: t.object({ plan: t.enumerated(...PLAN_CODES) }),
      policy: 'org:administer',
      /** Read-only. `destructive` defaults to true, so a read tool must say so. */
      destructive: false,
      async handle({ input, ctx }) {
        const org = await ctx.orgs.byId(actingOrg(ctx.actor));
        // The real period, off the calendar. It quoted `15` of `30` for every org on every day
        // until 2026-08, so a quote taken on the 2nd of February charged half a month — and no
        // month is 30 days in a zone that moves its clocks. The zone is the request's (`ctx.tz`),
        // which is the only one this app has: an org row carries no billing zone.
        return quoteUpgrade({
          from: org.planCode,
          to: input.plan,
          currency: org.billingCurrency,
          ...billingPeriodAt(ctx.now(), ctx.tz),
        });
      },
    },
  },
});
