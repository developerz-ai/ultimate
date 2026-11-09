/**
 * unit — `createPost`'s plan-dependent allowance: a free org's 100 drafts a UTC day, refused on
 * the 101st with `X_METER_EXCEEDED`, one `postsQuotaWarning` queued at 80, and an upgrade that
 * applies to the very next call, because the limit is resolved per call from the acting org.
 */

import { POST_ALLOWANCES } from '@postly/domain';
import { withFacts } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { planOf } from '../../../shared/actor';
import { createPost } from './create-post';

// No store reset here: the app preload hands every file a fresh meter store, so neither this
// file's 100 drafts nor another file's reach across (`@ultimat3/testing`'s preload).

const draft = (orgId: string, n: number) => ({
  orgId,
  title: `Quota draft ${n}`,
  body: 'x'.repeat(60),
});

test('a free org is held to its plan per UTC day, warned once at 80%, and an upgrade applies at once', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' });
  const actor = actorFor(author);
  expect(planOf({ actor })).toBe('free');
  const perDay = POST_ALLOWANCES.free.perDay;

  for (let n = 0; n < perDay; n += 1) await createPost.as(actor, draft(author.orgId, n));
  await expect(createPost.as(actor, draft(author.orgId, perDay))).rejects.toBeUltimateError(
    'X_METER_EXCEEDED',
  );
  const refusal = await createPost.as(actor, draft(author.orgId, perDay)).then(
    () => expect.unreachable('the 101st draft of the day is refused'),
    (error: unknown) => (error as { meta: Record<string, unknown> }).meta,
  );
  expect(refusal).toMatchObject({ meter: 'posts', limit: perDay });
  expect(String(refusal['resetsAt'])).toEndWith('T00:00:00.000Z');

  const trace = await runJobs.drain();
  expect(
    trace.executions.filter((run) => run.job === 'postsQuotaWarning').map((run) => run.outcome),
  ).toEqual(['completed']);

  // The same org on a bigger plan: the counter is the org's, the number is the plan's, read now.
  const upgraded = withFacts(actor, {
    org: {
      id: author.orgId,
      slug: 'acme',
      name: 'Acme',
      planCode: 'business',
      billingCurrency: 'USD',
      seats: 200,
      seatsUsed: 1,
    },
  });
  expect(planOf({ actor: upgraded })).toBe('business');
  await createPost.as(upgraded, draft(author.orgId, perDay + 1));
});

test('the declaration publishes its meter without inventing a number', () => {
  expect(createPost.describe().meter).toEqual({
    name: 'posts',
    period: 'day',
    timeZone: 'UTC',
    limit: null,
    warnAt: 0.8,
  });
  expect(createPost.describe().rateLimitPerCall).toEqual({ windowMs: 60_000 });
});
