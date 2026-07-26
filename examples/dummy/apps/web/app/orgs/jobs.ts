/**
 * Durable org work. `onboardOrg` spans three days: `step.sleep` persists a wake time and releases
 * the worker, so nothing is held open and the job resumes in a different process.
 */

import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { inviteEmail, nudgeEmail, welcomeEmail } from './mail';

export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`, // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step, ctx }) {
    const org = await step.run('provision', () => ctx.orgs.provision(input.orgId));
    await step.run('welcome-email', () => ctx.mail.send(welcomeEmail, org));
    await step.sleep('3d');
    await step.run('nudge', () => ctx.mail.send(nudgeEmail, org));
  },
});

export const sendInvite = job({
  input: t.object({ memberId: t.uuid }),
  idempotencyKey: ({ memberId }) => `invite:${memberId}`,
  retry: { attempts: 3, backoff: 'exponential' },
  queue: 'mail',
  async run({ input, step, ctx }) {
    const member = await step.run('load-member', () => ctx.orgs.memberById(input.memberId));
    await step.run('send', () => ctx.mail.send(inviteEmail, member));
  },
});
