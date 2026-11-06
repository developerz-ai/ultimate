// `requestMemberErasure`, the settings slice's action — one primitive per file.
//
// An owner acting on a member's request to be forgotten. The policy is Postly's (`orgAdminister`):
// the framework ships the erase, never who may ask for it. The work is `eraseMember`, a job.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
import { orgAdminister } from '../../orgs/policy';
import { eraseMember } from '../jobs/erase-member';

export const requestMemberErasure = action({
  input: t.object({ orgId: t.uuid, memberId: t.uuid }),
  output: t.object({ jobId: t.string }),
  policy: orgAdminister,
  errors: [],
  idempotent: true,
  async handle({ input }) {
    const queued = await eraseMember.enqueue(input);
    return { jobId: queued.id };
  },
});
