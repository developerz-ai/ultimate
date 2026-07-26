/**
 * Postly's MCP server. `include: 'exposed'` pulls in every action and query that declared
 * `mcp: { expose: true }` — with their policies, not copies of them. Only tools that are *not*
 * actions are written out here.
 */

import { localDateIn, nextDigestAt, quoteUpgrade, seatsRemaining } from '@postly/core';
import { PLAN_CODES, seatLimit } from '@postly/domain';
import { defineAppMcp } from '@ultimat3/mcp';
import { t } from '@ultimat3/schema';

export const mcp = defineAppMcp({
  name: 'postly',
  /** Every `mcp: { expose: true }` declaration in the app, with its policy unchanged. */
  include: 'exposed',
  /** Exposes the versioned prompt artifact so an agent can read what the model was told. */
  prompts: ['apps/web/app/posts/prompts/summarize.v3.md'],

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
        const at = nextDigestAt(ctx.now(), ctx.actor.tz);
        const posts = await ctx.posts.publishedSince(
          ctx.actor.orgId,
          new Date(at.getTime() - 86_400_000),
        );
        return {
          deliverAt: at.toISOString(),
          localDate: localDateIn(at, ctx.actor.tz),
          zone: ctx.actor.tz,
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
        const org = await ctx.orgs.byId(ctx.actor.orgId);
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
        const org = await ctx.orgs.byId(ctx.actor.orgId);
        return quoteUpgrade({
          from: org.planCode,
          to: input.plan,
          currency: org.billingCurrency,
          daysRemaining: 15,
          daysInCycle: 30,
        });
      },
    },
  },
});
