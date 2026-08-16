/**
 * Durable org work. `onboardOrg` spans three days: `step.sleep` persists a wake time and releases
 * the worker, so nothing is held open and the job resumes in a different process.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { inviteEmail, nudgeEmail, welcomeEmail } from './mail';

export const onboardOrg = job({
  // The recipient rides in the payload: a job resumed three days later must not depend on a
  // request context that stopped existing the moment the signup returned.
  input: t.object({ orgId: t.uuid, to: t.email, locale: t.locale }),
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`, // REQUIRED by the type
  // The org this run acts as, and it is the one the payload already names: `memberCount` inside
  // `ctx.orgs.byId` reads `members`, which is tenant-scoped, so without this the seat count is a
  // read no actor owns.
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step, ctx }) {
    // There is nothing to provision. A disk is declared in `app.config.ts` and built once at
    // boot, and an org's objects are separated by the `org/<orgId>/` key prefix rather than by a
    // bucket of their own — so the org row existing is the whole precondition for the mails
    // below, and this step loads it once instead of re-reading it per mail.
    const org = await step.run('load-org', () => ctx.orgs.byId(toOrgId(input.orgId)));
    const recipient = { to: input.to, locale: input.locale };

    await step.run('welcome-email', () => send(welcomeEmail, org, recipient));
    // Suspends the run and releases the worker; three days later a different process resumes it
    // with every earlier step replayed from storage rather than re-executed.
    await step.sleep('3d');
    await step.run('nudge', () => send(nudgeEmail, org, recipient));
  },
});

export const sendInvite = job({
  /**
   * `orgId` rides beside the member id because `members` is tenant-scoped and the org is not
   * recoverable from a member id without already being inside the tenant: `ctx.orgs.memberById`
   * scopes by the ACTING actor's org, and the only thing that puts one on a job's actor is this
   * declaration. `inviteMember` takes it off the row it just wrote, which is the org the member
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
      ctx.orgs.memberById(toMemberId(input.memberId)),
    );
    await step.run('send', () =>
      send(inviteEmail, member, { to: member.email, locale: member.locale }),
    );
  },
});
