// `erasureApprovalOptions` — what an owner's browser signs before `requestMemberErasure` runs: a
// challenge derived from THIS org and THIS member, for `getPasskey(options)`. The approval it
// yields is spent by that one erasure and no other.

import { action, t } from '@ultimat3/action';
import { orgAdminister } from '../../orgs/policy';
import { passkeys } from '../passkeys';

export const erasureApprovalOptions = action({
  input: t.object({ orgId: t.uuid, memberId: t.uuid }),
  output: t.json(),
  policy: orgAdminister,
  errors: ['X_PASSKEY_STEP_UP_REQUIRED'],
  handle: ({ input, ctx }) => passkeys.erasure.options({ userId: ctx.actor.id, input }),
});
