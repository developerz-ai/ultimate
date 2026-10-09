// `onboardOrg`, the orgs slice's job — one primitive per file, the layout `x g` writes.
//
// Durable org work. `onboardOrg` spans three days: `step.sleep` persists a wake time and releases
// the worker, so nothing is held open and the job resumes in a different process.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { nudgeEmail, welcomeEmail } from '../mail';

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
