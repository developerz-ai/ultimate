/**
 * Org commands. `inviteMember` is where the seat limit bites; `upgradePlan` is where money is
 * handled — in integer minor units, quoted by `@postly/core`, formatted by nobody here.
 */

import { tag } from '@postly/db';
import { PLAN_CODES } from '@postly/domain';
import { action } from '@ultimat3/action';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { InviteInput, MemberView, UpgradeReceipt } from './entity';
import { sendInvite } from './jobs';

export const inviteMember = action({
  input: InviteInput,
  output: MemberView,
  policy: can('org:invite'),
  cache: { invalidates: [tag.member, tag.org] },
  mcp: { expose: true, description: 'Invite a person to the actor’s organisation' },
  async handle({ input, ctx }) {
    const member = await ctx.orgs.invite(input);
    // Same transaction as the insert: a rolled-back invite never mails anyone.
    await ctx.jobs.enqueue(sendInvite, { memberId: member.id });
    return member;
  },
});

export const upgradePlan = action({
  input: t.object({ plan: t.enumerated(...PLAN_CODES) }),
  output: UpgradeReceipt,
  policy: can('org:administer'),
  cache: { invalidates: [tag.org, tag.plan] },
  mcp: {
    expose: true,
    description: 'Move the organisation to a higher plan and return the prorated receipt',
  },
  async handle({ input, ctx }) {
    return ctx.orgs.upgrade(input.plan);
  },
});
