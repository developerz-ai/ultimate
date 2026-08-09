/**
 * Org commands. `inviteMember` is where the seat limit bites; `upgradePlan` is where money is
 * handled — in integer minor units, quoted by `@postly/core`, formatted by nobody here.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { tag } from '@postly/db';
import { memberId, PLAN_CODES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { InviteInput, MemberView, UpgradeReceipt } from './entity';
import { sendInvite } from './jobs';
import { orgAdminister, orgInvite } from './policy';

export const inviteMember = action({
  // orgId rides in the input because `orgInvite` decides on it — the rule reads the declaration,
  // never the database.
  input: InviteInput.extend({ orgId: t.uuid }),
  output: MemberView,
  policy: orgInvite,
  cache: { invalidates: [tag.member, tag.org] },
  mcp: { expose: true, description: 'Invite a person to the actor’s organisation' },
  async handle({ input, ctx }) {
    const member = await ctx.orgs.invite(input);
    // The job enqueues itself, in the same transaction as the insert: a rolled-back invite never
    // mails anyone.
    await sendInvite.enqueue({ memberId: memberId(member.id) });
    return member;
  },
});

export const upgradePlan = action({
  input: t.object({ orgId: t.uuid, plan: t.enumerated(...PLAN_CODES) }),
  output: UpgradeReceipt,
  policy: orgAdminister,
  cache: { invalidates: [tag.org, tag.plan] },
  mcp: {
    expose: true,
    description: 'Move the organisation to a higher plan and return the prorated receipt',
  },
  async handle({ input, ctx }) {
    return ctx.orgs.upgrade(input.plan);
  },
});
