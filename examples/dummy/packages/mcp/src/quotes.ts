/**
 * A per-caller catalog — `defineAppMcp({ catalog })`: one `quote_<plan>` tool for each plan the
 * acting org can still move to. Acme (team) sees `quote_business`; Tinta (free) sees `quote_team`
 * and `quote_business`; an org on the top plan sees none. Which tools exist is data, so it is
 * resolved per request — never a list this file could write out.
 *
 * Each is a `runtimeTool()` borrowing `org:administer`, the permission `planQuote` already
 * declares: no rule is invented for a runtime tool. A person on a `tenant` server (no org of their
 * own) is listed the union over their orgs; the call names one, and resolves that org's tools.
 */

import { billingPeriodAt, memberOf, NotAMember, quoteUpgrade } from '@postly/core';
import { isAtLeast, isUpgrade, orgId, PLAN_CODES, type PlanCode } from '@postly/domain';
import { asCallerContext } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { agentActor, stringField, useContext } from '@ultimat3/core';
import type { McpCaller, McpRuntimeCatalog } from '@ultimat3/mcp';
import { runtimeTool } from '@ultimat3/mcp';
import type { PostlyMemberships } from './tenants';

/** The plan of each org this caller acts in: their own, or — for a person — every membership's. */
async function plansOf(
  caller: McpCaller,
  memberships: PostlyMemberships | undefined,
): Promise<readonly PlanCode[]> {
  const actors: readonly Actor[] =
    memberOf(caller.actor) !== null
      ? [caller.actor]
      : ((await memberships?.(caller.actor)) ?? []).map((member) =>
          agentActor({ id: member.memberId, orgId: member.orgId, roles: [member.role] }),
        );
  // The resolver filters by caller, as `visibleTo` would: `org:administer` is the owner's
  // (`shared/policies.ts`), so nobody else is listed a tool their policy refuses or reads an org row.
  const owners = actors.filter((actor) => {
    const member = memberOf(actor);
    return member !== null && isAtLeast(member.role, 'owner');
  });
  return Promise.all(
    owners.map((actor) =>
      asCallerContext(actor, async () => {
        const member = memberOf(actor);
        if (member === null) throw new NotAMember(actor.id);
        try {
          return [(await useContext().orgs.byId(orgId(member.orgId))).planCode];
        } catch (thrown) {
          // An org that does not exist has no plan to move from: no quotes, not a broken catalog.
          // Anything else (the database is down) fails the request, as the framework asks.
          if (stringField(thrown, 'code') === 'X_ORG_NOT_FOUND') return [];
          throw thrown;
        }
      }),
    ),
  ).then((plans) => plans.flat());
}

const quoteTool = (to: PlanCode) =>
  runtimeTool({
    name: `quote_${to}`,
    description: `Quote a prorated move to the ${to} plan, in minor units, for the acting organisation. Charges nothing — upgradePlan moves.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'org:administer',
    destructive: false,
    async run({ ctx }) {
      const member = memberOf(ctx.actor);
      if (member === null) throw new NotAMember(ctx.actor.id);
      const org = await ctx.orgs.byId(member.orgId);
      return quoteUpgrade({
        from: org.planCode,
        to,
        currency: org.billingCurrency,
        ...billingPeriodAt(ctx.now(), ctx.tz),
      });
    },
  });

/** The catalog resolver `postlyMcp` hands `defineAppMcp`. */
export const postlyQuotes =
  (memberships: PostlyMemberships | undefined) =>
  async (caller: McpCaller): Promise<McpRuntimeCatalog> => {
    const plans = await plansOf(caller, memberships);
    const targets = PLAN_CODES.filter((to) => plans.some((from) => isUpgrade(from, to)));
    return { tools: targets.map(quoteTool) };
  };
