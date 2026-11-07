// `requestMemberErasure`, the settings slice's action — one primitive per file.
//
// An owner acting on a member's request to be forgotten. The policy is Postly's (`orgAdminister`):
// the framework ships the erase, never who may ask for it. The work is `eraseMember`, a job.
//
// Irreversible, so it takes a passkey step-up: `approval` is the owner's `getPasskey` answer to
// `erasureApprovalOptions` for THIS org and member. Without one, or with one for another member,
// nothing is enqueued (`X_PASSKEY_STEP_UP_REQUIRED`); the verified approval is stored as evidence.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
import { passkeys } from '../../auth/passkeys';
import { orgAdminister } from '../../orgs/policy';
import { eraseMember } from '../jobs/erase-member';

export const requestMemberErasure = action({
  input: t.object({ orgId: t.uuid, memberId: t.uuid, approval: t.json() }),
  output: t.object({ jobId: t.string }),
  policy: orgAdminister,
  errors: ['X_PASSKEY_STEP_UP_REQUIRED', 'X_PASSKEY_INVALID', 'X_PASSKEY_CHALLENGE_EXPIRED'],
  idempotent: true,
  async handle({ input, ctx }) {
    const { orgId, memberId } = input;
    await passkeys.erasure.verify({
      userId: ctx.actor.id,
      input: { orgId, memberId },
      response: input.approval,
    });
    const queued = await eraseMember.enqueue({ orgId, memberId });
    return { jobId: queued.id };
  },
});
