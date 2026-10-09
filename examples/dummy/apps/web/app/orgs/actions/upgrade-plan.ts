// `upgradePlan`, the orgs slice's action — one primitive per file, the layout `x g` writes.
//
// Org commands. `inviteMember` is where the seat limit bites; `upgradePlan` is where money is
// handled — in integer minor units, quoted by `@postly/core`, formatted by nobody here.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { tag } from '@postly/db';
import { PLAN_CODES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { UpgradeReceipt } from '../entity';
import { orgAdminister } from '../policy';

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
