/**
 * unit — `posts.like-totals` against the app's migrated database: the materialized view answers
 * what it held at its last refresh until the job recomputes it, each org reads its own totals
 * through the tenant column, and a write to it is refused before any statement.
 */

import { db, postLikeTotals } from '@postly/db';
import { migratedDatabase } from '@ultimat3/cli';
import { ctxOf, runWithContext, serviceActor } from '@ultimat3/core';
import { setDbClient } from '@ultimat3/db';
import { memoryStepStore, stepRunner } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, reusableDatabase, test } from '@ultimat3/testing';
import { likeTotalsRefresh } from './like-totals';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
afterAll(() => setDbClient(undefined));

const refresh = () => {
  const ctx = ctxOf({ role: 'worker', actor: serviceActor({ id: 'worker' }) });
  return runWithContext(ctx, () =>
    likeTotalsRefresh.run({
      input: {},
      step: stepRunner({ runId: 'r1', jobName: likeTotalsRefresh.name, store: memoryStepStore() })
        .step,
      ctx,
      attempt: 1,
      finalAttempt: true,
      progress: () => undefined,
      jobId: 'r1',
      runId: 'r1',
    }),
  );
};

test('the view holds its last refresh, each org reads its own, and nothing writes it', async ({
  seed,
  actorFor,
}) => {
  const { post, other, ada, mara } = await seed('dev').pick({
    post: 'post:tenancy',
    other: 'post:timezones',
    ada: 'member:ada',
    mara: 'member:mara',
  });
  const asAda = <T>(read: () => Promise<T>) =>
    runWithContext(ctxOf({ actor: actorFor(ada) }), read);
  const totals = () => asAda(() => db.postLikeTotals.orderBy('postId').all());

  // Created populated by the migration, before the seed wrote a like: nothing yet.
  expect(await totals()).toEqual([]);
  expect(await refresh()).toEqual({ view: 'post_like_totals', concurrently: true });
  const counted = new Map((await totals()).map((row) => [row.postId, row.likes]));
  expect(counted.get(post.id)).toBe(2);
  expect(counted.get(other.id)).toBe(1);

  // Another org's member: the tenant column bounds the view as it bounds a table.
  const theirs = await runWithContext(ctxOf({ actor: actorFor(mara) }), () =>
    db.postLikeTotals.where({ postId: post.id }).all(),
  );
  expect(theirs).toEqual([]);

  await expect(
    asAda(() => db.postLikeTotals.insert({ orgId: post.orgId, postId: post.id, likes: 9 })),
  ).rejects.toBeUltimateError('X_ENTITY_VIEW_READ_ONLY');
  expect(postLikeTotals.$viewQuery?.materialized).toBe(true);
});
