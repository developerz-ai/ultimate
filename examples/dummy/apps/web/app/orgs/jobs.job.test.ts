/**
 * job — the guarantees, not the happy path: step replay, idempotency dedupe, outbox atomicity,
 * and that `step.sleep('3d')` is the frozen clock's problem rather than a held connection.
 */

import { expect, test } from '@ultimat3/testing';
import { inviteMember } from './actions';
import { onboardOrg, sendInvite } from './jobs';
import { nudgeEmail } from './mail';

test('onboardOrg retries only the failed step', async ({ seed, clock, mail, runJobs }) => {
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });
  mail.failOnce(nudgeEmail);

  await runJobs(onboardOrg, { orgId: org.id, to: owner.email, locale: owner.locale });
  clock.advance('3d');
  const trace = await runJobs.drain();

  expect(trace.steps['load-org'].executions).toBe(1); // replayed from the step log, not re-run
  expect(trace.steps['welcome-email'].executions).toBe(1);
  expect(trace.steps.nudge.executions).toBe(2); // only this one retried
});

test('the three-day sleep releases the worker instead of holding it', async ({
  seed,
  clock,
  runJobs,
}) => {
  const { org, owner } = await seed('dev').pick({ org: 'org:tinta', owner: 'member:mara' });

  await runJobs(onboardOrg, { orgId: org.id, to: owner.email, locale: owner.locale });
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
