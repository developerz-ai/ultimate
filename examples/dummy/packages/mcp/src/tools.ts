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
import { type AppMcp, type DefineAppMcpInput, defineAppMcp, t } from '@ultimat3/mcp';
import { confirmAgentPublish } from './confirmations';

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

/**
 * The server, around what only this package writes — the name, the prompt artifact and the tools
 * that are not actions — plus whatever of the registry and the gate the caller asks for. One literal
 * inside the call, so every handler keeps its contextual types.
 */
const build = (registry: Pick<DefineAppMcpInput, 'include' | 'confirmations'>): AppMcp =>
  defineAppMcp({
    name: 'postly',
    ...registry,
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

/**
 * Postly's MCP server, BUILT ON CALL and never at import. `include: 'exposed'` reads the action
 * registry when the server is built, and the gate (`confirmations`) refuses at build a tool the
 * registry does not hold (`X_MCP_CONFIRMATION_TOOL_UNKNOWN`) — rightly, since that call would run
 * unconfirmed. `publishPost` is registered by `apps/web/api`, a layer this package cannot import,
 * so a module-scope server was correct only when something else had booted the API first: an
 * import order, not a dependency. As a function the order is the caller's, stated where it is
 * called — after `apps/web/api` has registered (the app's boot, or its test preload).
 */
export const postlyMcp = (): AppMcp =>
  build({
    /** Every `mcp: { expose: true }` declaration in the app, with its policy unchanged. */
    include: 'exposed',
    /** `publishPost` waits for a person: `./confirmations.ts`. */
    confirmations: confirmAgentPublish,
  });

/**
 * The hand-written tools alone, with no registry read and no gate — what `tools.test.ts` asserts
 * against, so that test means the same thing whichever modules a run booted first.
 */
export const postlyHandWrittenMcp = (): AppMcp => build({});
