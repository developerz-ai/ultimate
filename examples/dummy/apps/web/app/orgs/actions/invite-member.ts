// `inviteMember`, the orgs slice's action — one primitive per file, the layout `x g` writes.
//
// Org commands. `inviteMember` is where the seat limit bites; `upgradePlan` is where money is
// handled — in integer minor units, quoted by `@postly/core`, formatted by nobody here.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { tag } from '@postly/db';
import { memberId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { InviteInput, MemberView } from '../entity';
import { sendInvite } from '../jobs/send-invite';
import { orgInvite } from '../policy';

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
    // The org comes off the row that was just written, never off the input: `ctx.orgs.invite`
    // seats the member in the ACTOR's org, and that is the tenant the job has to run as.
    await sendInvite.enqueue({ memberId: memberId(member.id), orgId: member.orgId });
    return member;
  },
});
