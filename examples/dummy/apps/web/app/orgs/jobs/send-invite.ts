// `sendInvite`, the orgs slice's job — one primitive per file, the layout `x g` writes.
//
// Durable org work. `onboardOrg` spans three days: `step.sleep` persists a wake time and releases
// the worker, so nothing is held open and the job resumes in a different process.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { inviteEmail } from '../mail';

export const sendInvite = job({
  /**
   * `orgId` rides beside the member id because `members` is tenant-scoped and the org is not
   * recoverable from a member id without already being inside the tenant. It is also the org the
   * read NAMES — `ctx.orgs.memberIn`, never `memberById`, which needs an acting member, and a
   * served worker's actor is nobody: it carries the org this declaration put there and no more. `inviteMember` takes it off the row it just wrote, which is the org the member
   * actually landed in.
   */
  input: t.object({ memberId: t.uuid, orgId: t.uuid }),
  /** The member id alone: it is a uuid primary key, so the org would narrow nothing. */
  idempotencyKey: ({ memberId }) => `invite:${memberId}`,
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 3, backoff: 'exponential' },
  queue: 'mail',
  async run({ input, step, ctx }) {
    const member = await step.run('load-member', () =>
      ctx.orgs.memberIn(toOrgId(input.orgId), toMemberId(input.memberId)),
    );
    await step.run('send', () =>
      send(inviteEmail, member, { to: member.email, locale: member.locale }),
    );
  },
});
