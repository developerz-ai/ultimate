/**
 * job — the guarantees, not the happy path: step replay, idempotency dedupe, outbox atomicity,
 * and that `step.sleep('3d')` is the frozen clock's problem rather than a held connection.
 */

import { expect, test } from '@ultimat3/testing';
import { inviteMember } from './actions';
import { onboardOrg, sendInvite } from './jobs';
import { nudgeEmail } from './mail';

/** Any org and any member: what is under test is where the two jobs READ the tenant from. */
const ORG = '00000000-0000-4000-8000-00000000c001';
const MEMBER = '00000000-0000-4000-8000-00000000c0a1';

test('both org jobs run as the org their payload names', () => {
  expect(onboardOrg.tenantFor({ orgId: ORG, to: 'mara@tinta.example', locale: 'en' })).toBe(ORG);
  // `memberId` alone cannot answer this: `ctx.orgs.memberById` scopes by the ACTING actor's org,
  // and a job's actor has one only because this declaration put it there.
  expect(sendInvite.tenantFor({ memberId: MEMBER, orgId: ORG })).toBe(ORG);
});

/**
 * Two guarantees, and the second is the one a reader gets wrong: a resumed run replays its
 * finished steps instead of re-running them, and a transport blip costs one MAIL retry rather than
 * a re-execution of the step that sent it.
 *
 * This asserted `nudge.executions === 2` until 2026-08 and could not have been true: `send()`
 * enqueues `mail.send` whenever a queue driver is installed (`packages/mail/src/mail.ts`), so
 * `mail.failOnce` fails the mail JOB — the step enqueued, succeeded, and was never a candidate to
 * retry. Making it true would mean `sync: true` in production job code so a test can watch a step
 * fail, which is the wrong thing for the reference app to teach; the retry is real either way, and
 * it is asserted below where it actually happens.
 */
test('a resumed run replays its steps, and a mail blip retries the mail job', async ({
  seed,
  clock,
  mail,
  runJobs,
}) => {
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });
  mail.failOnce(nudgeEmail);

  await runJobs(onboardOrg, { orgId: org.id, to: owner.email, locale: owner.locale });
  clock.advance('3d');
  const resumed = await runJobs.drain();

  expect(resumed.steps['load-org'].executions).toBe(1); // replayed from the step log, not re-run
  expect(resumed.steps['welcome-email'].executions).toBe(1);
  expect(resumed.steps.nudge.executions).toBe(1);
  // The welcome mail is delivered and the nudge is not: its send was refused, and what is left in
  // the queue is the mail job on its backoff.
  expect(mail.outbox().length).toBe(1);

  clock.advance('1h');
  const retried = await runJobs.drain();

  expect(mail.outbox().length).toBe(2); // the second attempt is the mail job's, and it lands
  expect(retried.steps.nudge.executions).toBe(1); // and the step it came from never ran again
});

// `mail` is not decoration: `welcome-email` sends before the sleep, and `send()` enqueues
// `mail.send` whenever a queue driver is installed. With no mail driver that job fails and sits
// in the queue on an exponential retry — inside the two-day window below — so `due()` counted the
// undelivered welcome mail and said the sleep had already lapsed.
test('the three-day sleep releases the worker instead of holding it', async ({
  seed,
  clock,
  mail,
  runJobs,
}) => {
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });

  await runJobs(onboardOrg, { orgId: org.id, to: owner.email, locale: owner.locale });
  expect(mail.outbox().length).toBe(1); // the welcome mail is delivered, so the sleep is all that is left
  expect(await runJobs.inFlight()).toBe(0); // suspended, not waiting

  clock.advance('2d');
  expect(await runJobs.due()).toBe(0);
  clock.advance('1d');
  expect(await runJobs.due()).toBe(1);
});

test('a duplicate enqueue with a live key returns the same job', async ({ seed, runJobs }) => {
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });

  const first = await runJobs.enqueue(onboardOrg, {
    orgId: org.id,
    to: owner.email,
    locale: owner.locale,
  });
  const second = await runJobs.enqueue(onboardOrg, {
    orgId: org.id,
    to: owner.email,
    locale: owner.locale,
  });

  expect(second.id).toBe(first.id);
  expect(await runJobs.depth()).toBe(1);
});

test('a rolled-back invite never enqueues its mail', async ({ seed, actorFor, runJobs }) => {
  // The free plan seats three; Tinta already has two, so the third invite fits and the fourth
  // fails inside the same transaction as the enqueue.
  const { owner } = await seed('dev').pick({ owner: 'member:mara' });
  const actor = actorFor(owner);

  await inviteMember.as(actor, {
    orgId: owner.orgId,
    email: 'third@tinta.example',
    role: 'author',
  });
  expect(await runJobs.depth(sendInvite)).toBe(1);

  await expect(
    inviteMember.as(actor, { orgId: owner.orgId, email: 'fourth@tinta.example', role: 'author' }),
  ).rejects.toBeUltimateError('X_BILLING_SEATS_EXCEEDED');

  expect(await runJobs.depth(sendInvite)).toBe(1); // no ghost job from the failed transaction
});
